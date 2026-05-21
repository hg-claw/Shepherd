package singbox

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// Resolution thresholds for auto-pick.
const (
	resolutionRawMax    = 2 * time.Hour       // span ≤ this → raw
	resolutionMinuteMax = 7 * 24 * time.Hour  // span ≤ this → minute; else → hour
)

// trafficPoint is one row of traffic data.
type trafficPoint struct {
	TS        time.Time `json:"ts"`
	BytesUp   int64     `json:"bytes_up"`
	BytesDown int64     `json:"bytes_down"`
}

// trafficResponse is the shape returned by GET /traffic.
type trafficResponse struct {
	ServerID   int64          `json:"server_id"`
	Tag        string         `json:"tag"`
	Kind       string         `json:"kind"`
	Resolution string         `json:"resolution"`
	Points     []trafficPoint `json:"points"`
}

// trafficSeries is one tag's time series inside a batch response.
type trafficSeries struct {
	Tag    string         `json:"tag"`
	Kind   string         `json:"kind"`
	Points []trafficPoint `json:"points"`
}

// trafficBatchResponse is the shape returned by GET /traffic/batch.
type trafficBatchResponse struct {
	Resolution string          `json:"resolution"`
	Series     []trafficSeries `json:"series"`
}

// httpErr is a user-facing HTTP error.
type httpErr struct {
	code int
	msg  string
}

func (e httpErr) Error() string { return e.msg }

func errBadRequest(msg string) error { return httpErr{code: 400, msg: msg} }

// chooseResolution returns the table suffix ("raw", "minute", or "hour") to
// query. When explicit is non-empty it is validated and returned directly.
// Otherwise the span (to - from) is used:
//
//	span ≤ 2h  → raw
//	span ≤ 7d  → minute
//	otherwise  → hour
func chooseResolution(from, to time.Time, explicit string) (string, error) {
	if explicit != "" {
		switch explicit {
		case "raw", "minute", "hour":
			return explicit, nil
		}
		return "", errBadRequest("resolution must be raw, minute, or hour")
	}
	span := to.Sub(from)
	switch {
	case span <= resolutionRawMax:
		return "raw", nil
	case span <= resolutionMinuteMax:
		return "minute", nil
	default:
		return "hour", nil
	}
}

func tableForResolution(res string) string {
	switch res {
	case "minute":
		return "singbox_traffic_minute"
	case "hour":
		return "singbox_traffic_hour"
	default:
		return "singbox_traffic_raw"
	}
}

// parseTrafficParams extracts and validates the common query parameters shared
// by both /traffic and /traffic/batch.
func parseTrafficParams(r *http.Request) (serverID int64, tag, kind string, from, to time.Time, resolution string, err error) {
	q := r.URL.Query()

	sidStr := q.Get("server_id")
	if sidStr == "" {
		err = errBadRequest("server_id required")
		return
	}
	sid64, e := strconv.ParseInt(sidStr, 10, 64)
	if e != nil {
		err = errBadRequest("invalid server_id")
		return
	}
	serverID = sid64

	tag = q.Get("tag")
	kind = q.Get("kind")

	fromStr := q.Get("from")
	toStr := q.Get("to")
	if fromStr == "" || toStr == "" {
		err = errBadRequest("from and to required")
		return
	}
	from, e = time.Parse(time.RFC3339, fromStr)
	if e != nil {
		err = errBadRequest("invalid from timestamp")
		return
	}
	to, e = time.Parse(time.RFC3339, toStr)
	if e != nil {
		err = errBadRequest("invalid to timestamp")
		return
	}
	resolution = q.Get("resolution")
	return
}

// writeHTTPErr writes an HTTP error, unwrapping httpErr for the status code.
func writeHTTPErr(w http.ResponseWriter, err error) {
	if he, ok := err.(httpErr); ok {
		http.Error(w, he.msg, he.code)
	} else {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

// queryPoints runs SELECT ts, bytes_up, bytes_down from the given table filtered
// by server_id, tag, optional kind, and the [from, to] time range.
func queryPoints(db *sqlx.DB, table, tag, kind string, serverID int64, from, to time.Time) ([]trafficPoint, error) {
	var query string
	var args []any
	if kind != "" {
		query = `SELECT ts, bytes_up, bytes_down FROM ` + table +
			` WHERE server_id = ? AND tag = ? AND kind = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC`
		args = []any{serverID, tag, kind, from.UTC(), to.UTC()}
	} else {
		query = `SELECT ts, bytes_up, bytes_down FROM ` + table +
			` WHERE server_id = ? AND tag = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC`
		args = []any{serverID, tag, from.UTC(), to.UTC()}
	}
	rows, err := db.Queryx(query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var pts []trafficPoint
	for rows.Next() {
		var p trafficPoint
		if err := rows.Scan(&p.TS, &p.BytesUp, &p.BytesDown); err != nil {
			return nil, err
		}
		pts = append(pts, p)
	}
	return pts, rows.Err()
}

// trafficQueryHandler handles GET /traffic?server_id=X&tag=Y&kind=K&from=ts&to=ts[&resolution=...]
func trafficQueryHandler(db *sqlx.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, tag, kind, from, to, resParam, err := parseTrafficParams(r)
		if err != nil {
			writeHTTPErr(w, err)
			return
		}
		if tag == "" {
			http.Error(w, "tag required", http.StatusBadRequest)
			return
		}

		res, err := chooseResolution(from, to, resParam)
		if err != nil {
			writeHTTPErr(w, err)
			return
		}

		table := tableForResolution(res)
		pts, err := queryPoints(db, table, tag, kind, serverID, from, to)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if pts == nil {
			pts = []trafficPoint{}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(trafficResponse{
			ServerID:   serverID,
			Tag:        tag,
			Kind:       kind,
			Resolution: res,
			Points:     pts,
		})
	}
}

// trafficBatchQueryHandler handles GET /traffic/batch?server_id=X&tags=t1,t2&kind=K&from=ts&to=ts[&resolution=...]
func trafficBatchQueryHandler(db *sqlx.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		serverID, _, kind, from, to, resParam, err := parseTrafficParams(r)
		if err != nil {
			writeHTTPErr(w, err)
			return
		}

		tagsRaw := r.URL.Query().Get("tags")
		if tagsRaw == "" {
			http.Error(w, "tags required", http.StatusBadRequest)
			return
		}
		tags := strings.Split(tagsRaw, ",")

		res, err := chooseResolution(from, to, resParam)
		if err != nil {
			writeHTTPErr(w, err)
			return
		}

		table := tableForResolution(res)
		series := make([]trafficSeries, 0, len(tags))
		for _, tag := range tags {
			tag = strings.TrimSpace(tag)
			if tag == "" {
				continue
			}
			pts, err := queryPoints(db, table, tag, kind, serverID, from, to)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			if pts == nil {
				pts = []trafficPoint{}
			}
			series = append(series, trafficSeries{Tag: tag, Kind: kind, Points: pts})
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(trafficBatchResponse{Resolution: res, Series: series})
	}
}
