package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/jmoiron/sqlx"
)

type PluginEventsAPI struct {
	DB *sqlx.DB
}

type eventOut struct {
	TS       string          `json:"ts"`
	AdminID  *int64          `json:"admin_id"`
	ServerID *int64          `json:"server_id"`
	Action   string          `json:"action"`
	Result   string          `json:"result"`
	Details  json.RawMessage `json:"details"`
}

func (a *PluginEventsAPI) List(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" {
		writeError(w, 400, "missing id")
		return
	}
	q := r.URL.Query()
	limit := 200
	if l := q.Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n <= 1000 {
			limit = n
		}
	}
	args := []any{"plugin." + id + ".%"}
	where := "action LIKE ?"
	if since := q.Get("since"); since != "" {
		if t, err := time.Parse(time.RFC3339, since); err == nil {
			where += " AND ts >= ?"
			args = append(args, t)
		}
	}
	if sid := q.Get("server_id"); sid != "" {
		if n, err := strconv.ParseInt(sid, 10, 64); err == nil {
			where += " AND server_id = ?"
			args = append(args, n)
		}
	}
	rows, err := a.DB.QueryxContext(r.Context(),
		"SELECT ts, admin_id, server_id, action, result, details_json FROM audit_log WHERE "+
			where+" ORDER BY ts DESC LIMIT ?", append(args, limit)...)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []eventOut{}
	for rows.Next() {
		var (
			ts     time.Time
			aID    *int64
			sID    *int64
			action string
			result string
			det    string
		)
		if err := rows.Scan(&ts, &aID, &sID, &action, &result, &det); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		out = append(out, eventOut{
			TS:       ts.UTC().Format(time.RFC3339),
			AdminID:  aID,
			ServerID: sID,
			Action:   action,
			Result:   result,
			Details:  json.RawMessage(det),
		})
	}
	writeJSON(w, 200, out)
}
