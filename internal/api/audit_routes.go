package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/jmoiron/sqlx"
)

type AuditAPI struct {
	DB *sqlx.DB
}

type auditRow struct {
	ID          int64     `db:"id" json:"id"`
	TS          time.Time `db:"ts" json:"ts"`
	AdminID     *int64    `db:"admin_id" json:"admin_id,omitempty"`
	ServerID    *int64    `db:"server_id" json:"server_id,omitempty"`
	Action      string    `db:"action" json:"action"`
	DetailsJSON string    `db:"details_json" json:"details"`
	Result      string    `db:"result" json:"result"`
}

func (a *AuditAPI) List(w http.ResponseWriter, r *http.Request) {
	q := `SELECT id, ts, admin_id, server_id, action, details_json, result FROM audit_log WHERE 1=1`
	args := []any{}
	if action := r.URL.Query().Get("action"); action != "" {
		q += " AND action=?"
		args = append(args, action)
	}
	if sid := r.URL.Query().Get("server_id"); sid != "" {
		v, _ := strconv.ParseInt(sid, 10, 64)
		q += " AND server_id=?"
		args = append(args, v)
	}
	if from := r.URL.Query().Get("from"); from != "" {
		if t, err := time.Parse(time.RFC3339, from); err == nil {
			q += " AND ts >= ?"
			args = append(args, t)
		}
	}
	if to := r.URL.Query().Get("to"); to != "" {
		if t, err := time.Parse(time.RFC3339, to); err == nil {
			q += " AND ts <= ?"
			args = append(args, t)
		}
	}
	q += " ORDER BY ts DESC LIMIT 1000"
	var rows []auditRow
	if err := a.DB.SelectContext(r.Context(), &rows, q, args...); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, rows)
}

func (a *AuditAPI) CSV(w http.ResponseWriter, r *http.Request) {
	a.List(w, r) // placeholder; frontend formats CSV from JSON
}
