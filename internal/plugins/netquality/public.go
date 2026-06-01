package netquality

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
)

// ISPSummary is one ISP's freshness number for a server, surfaced on the
// public wall when the plugin is enabled for that server. RTT/Loss are
// averages over the last LookbackSeconds window across every enabled
// target in that ISP bucket — gives a "this server feels X ms from
// $ISP right now" headline without leaking the full target list.
type ISPSummary struct {
	ISP      string  `json:"isp"` // telecom|unicom|mobile|overseas
	RTTAvgMs float64 `json:"rtt_avg_ms"`
	LossPct  float64 `json:"loss_pct"`
}

// LookbackSeconds is how far back the per-ISP average reaches. 30 minutes
// keeps the surfaced number "recent" without being so jumpy that a
// single bad probe spikes the public view.
const LookbackSeconds = 30 * 60

// LatestPerISP returns one row per ISP for which we have a recent
// sample. Returns an empty (nil, nil) slice — never an error — when the
// plugin's tables don't exist yet (plugin never enabled). The caller is
// the public wall handler and should not 500 because the wall doesn't
// know about us.
func LatestPerISP(ctx context.Context, db *sqlx.DB, serverID int64) []ISPSummary {
	// First: cheap "are we configured?" check. A server without
	// netquality_hosts.enabled=true has nothing to show; the broader
	// SELECT below would still work but burns a query for nothing.
	var enabled bool
	if err := db.GetContext(ctx, &enabled,
		`SELECT enabled FROM netquality_hosts WHERE server_id = $1`, serverID); err != nil {
		return nil // no row, or table missing — both mean "off"
	}
	if !enabled {
		return nil
	}

	// We aggregate over the RAW table so the public number reflects the
	// freshest data — minute rollups lag by up to ~1 min. Filter on UTC
	// epoch math computed by the driver to avoid embedding portable
	// time literals in SQL.
	cutoff := time.Now().UTC().Add(-1 * time.Duration(LookbackSeconds) * time.Second)

	var rows []ISPSummary
	err := db.SelectContext(ctx, &rows, `
		SELECT t.isp AS isp,
		       AVG(s.rtt_avg_ms) AS rtt_avg_ms,
		       AVG(s.loss_pct)   AS loss_pct
		  FROM netquality_targets t
		  JOIN netquality_samples_raw s ON s.target_id = t.id
		 WHERE s.server_id = $1
		   AND t.enabled = true
		   AND s.ts > $2
		   AND s.status = 'ok'
		 GROUP BY t.isp
		 ORDER BY t.isp`,
		serverID, cutoff)
	if err != nil {
		return nil
	}
	return rows
}

// ispRow scans one (server, ISP) summary cell for the batch query.
type ispRow struct {
	ServerID int64   `db:"server_id"`
	ISP      string  `db:"isp"`
	RTTAvgMs float64 `db:"rtt_avg_ms"`
	LossPct  float64 `db:"loss_pct"`
}

// LatestPerISPForAll is the batch analogue of LatestPerISP: one grouped query
// over the id set, returning per-server ISP summaries keyed by server_id. Hosts
// not enabled (or with no recent ok samples) are absent from the map. Returns an
// empty map — never an error — so the public wall never 500s on us.
func LatestPerISPForAll(ctx context.Context, db *sqlx.DB, ids []int64) map[int64][]ISPSummary {
	out := map[int64][]ISPSummary{}
	if len(ids) == 0 {
		return out
	}
	cutoff := time.Now().UTC().Add(-1 * time.Duration(LookbackSeconds) * time.Second)
	query, args, err := sqlx.In(`
		SELECT s.server_id AS server_id, t.isp AS isp,
		       AVG(s.rtt_avg_ms) AS rtt_avg_ms,
		       AVG(s.loss_pct)   AS loss_pct
		  FROM netquality_targets t
		  JOIN netquality_samples_raw s ON s.target_id = t.id
		  JOIN netquality_hosts h ON h.server_id = s.server_id
		 WHERE s.server_id IN (?)
		   AND h.enabled = true
		   AND t.enabled = true
		   AND s.ts > ?
		   AND s.status = 'ok'
		 GROUP BY s.server_id, t.isp
		 ORDER BY s.server_id, t.isp`, ids, cutoff)
	if err != nil {
		return out
	}
	query = db.Rebind(query)
	var rows []ispRow
	if err := db.SelectContext(ctx, &rows, query, args...); err != nil {
		return out
	}
	for _, r := range rows {
		out[r.ServerID] = append(out[r.ServerID], ISPSummary{ISP: r.ISP, RTTAvgMs: r.RTTAvgMs, LossPct: r.LossPct})
	}
	return out
}

// HistoryPoint is one (timestamp, ISP) cell in the public per-server
// history chart. The minute or hour rollup row picks the bucket grain;
// we aggregate ACROSS the targets in that ISP so the chart line is
// "average RTT my server feels from this ISP at this minute", not "RTT
// to a specific resolver" (which could leak the full target list).
type HistoryPoint struct {
	TS       time.Time `db:"ts"         json:"ts"`
	ISP      string    `db:"isp"        json:"isp"`
	RTTAvgMs *float64  `db:"rtt_avg_ms" json:"rtt_avg_ms,omitempty"`
	LossPct  *float64  `db:"loss_pct"   json:"loss_pct,omitempty"`
}

// HistoryRange names the time window. We honour the same vocabulary as
// the rest of the public API (1h / 24h / 7d) and pick the resolution
// internally — minute for short ranges, hour for long ones — so the
// caller doesn't have to know about our rollup tables.
type HistoryRange string

const (
	History1h  HistoryRange = "1h"
	History24h HistoryRange = "24h"
	History7d  HistoryRange = "7d"
)

// HistoryRow groups all points for one ISP. The wire shape JSON is
// {isp, points: [{ts, rtt_avg_ms, loss_pct}, ...]} so the front-end can
// render one line per ISP without pivoting client-side.
type HistoryRow struct {
	ISP    string         `json:"isp"`
	Points []HistoryPoint `json:"points"`
}

// LatestHistory returns one HistoryRow per ISP for the given server and
// range. Returns nil silently when the plugin is disabled for this
// server or the underlying table is missing — public callers must not
// 500 because they don't know if the plugin is on.
func LatestHistory(ctx context.Context, db *sqlx.DB, serverID int64, rng HistoryRange) []HistoryRow {
	var enabled bool
	if err := db.GetContext(ctx, &enabled,
		`SELECT enabled FROM netquality_hosts WHERE server_id = $1`, serverID); err != nil {
		return nil
	}
	if !enabled {
		return nil
	}

	// Pick window + table. Minute rollup has 1-min grain; hour rollup
	// has 1-hour grain. Going through rollups instead of raw keeps the
	// public query cheap even at 7d range.
	var from time.Time
	var table string
	now := time.Now().UTC()
	switch rng {
	case History1h:
		from = now.Add(-1 * time.Hour)
		table = "netquality_samples_minute"
	case History24h:
		from = now.Add(-24 * time.Hour)
		table = "netquality_samples_minute"
	case History7d:
		from = now.Add(-7 * 24 * time.Hour)
		table = "netquality_samples_hour"
	default:
		// Unknown range from a sloppy client — silently downgrade to
		// 1h rather than error. The public endpoint never returns
		// 4xx body so callers don't get to fingerprint the plugin.
		from = now.Add(-1 * time.Hour)
		table = "netquality_samples_minute"
	}

	var rows []HistoryPoint
	if err := db.SelectContext(ctx, &rows, `
		SELECT s.ts AS ts,
		       t.isp AS isp,
		       AVG(s.rtt_avg_ms) AS rtt_avg_ms,
		       AVG(s.loss_pct)   AS loss_pct
		  FROM `+table+` s
		  JOIN netquality_targets t ON s.target_id = t.id
		 WHERE s.server_id = $1
		   AND t.enabled = true
		   AND s.ts >= $2
		 GROUP BY s.ts, t.isp
		 ORDER BY s.ts, t.isp`,
		serverID, from); err != nil {
		return nil
	}

	// Pivot ts × isp → one HistoryRow per ISP. Stable iteration order
	// (telecom → unicom → mobile → overseas) makes the chart legend
	// consistent across reloads.
	byISP := map[string][]HistoryPoint{}
	for _, r := range rows {
		byISP[r.ISP] = append(byISP[r.ISP], r)
	}
	out := make([]HistoryRow, 0, 4)
	for _, isp := range []string{"telecom", "unicom", "mobile", "overseas"} {
		if pts, ok := byISP[isp]; ok {
			out = append(out, HistoryRow{ISP: isp, Points: pts})
		}
	}
	return out
}
