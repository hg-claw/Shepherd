package sshaudit

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/hg-claw/Shepherd/internal/httpjson"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

// All admin endpoints are mounted at /api/admin/plugins/sshaudit (handled by
// the gated mux in router.go). Auth is the admin bearer — the gate is opaque
// to handlers here.

var errUnknownServer = errors.New("unknown server")

// RegisterRoutes wires every sshaudit admin REST endpoint.
func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	p.deps = deps
	if p.running == nil {
		p.running = map[int64]bool{}
	}

	mux.HandleFunc("GET /hosts", p.listHosts)
	mux.HandleFunc("PUT /hosts/{server_id}", p.upsertHost)
	mux.HandleFunc("GET /hosts/{server_id}/sessions", p.liveSessions)
	mux.HandleFunc("GET /hosts/{server_id}/events", p.listEvents)
	mux.HandleFunc("GET /hosts/{server_id}/summary", p.getSummary)
	mux.HandleFunc("POST /hosts/{server_id}/collect", p.collectNow)
}

// hostRow is the JSON shape returned by GET /hosts. Only rows actually
// present in sshaudit_hosts are returned (the UI joins with the server list).
type hostRow struct {
	ServerID            int64      `db:"server_id"             json:"server_id"`
	Enabled             bool       `db:"enabled"               json:"enabled"`
	PollIntervalSeconds int        `db:"poll_interval_seconds" json:"poll_interval_seconds"`
	LastCollectAt       *time.Time `db:"last_collect_at"       json:"last_collect_at"`
	LastError           *string    `db:"last_error"            json:"last_error"`
}

func (p *Plugin) listHosts(w http.ResponseWriter, r *http.Request) {
	rows := []hostRow{}
	if err := p.deps.DB.SelectContext(r.Context(), &rows, `
		SELECT server_id, enabled, poll_interval_seconds, last_collect_at, last_error
		  FROM sshaudit_hosts ORDER BY server_id`); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, rows)
}

type upsertHostBody struct {
	Enabled             bool `json:"enabled"`
	PollIntervalSeconds *int `json:"poll_interval_seconds"`
}

func (p *Plugin) upsertHost(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var b upsertHostBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	interval := 300
	if b.PollIntervalSeconds != nil {
		interval = *b.PollIntervalSeconds
	}
	if interval < 60 {
		interval = 60
	}
	// Validate the server exists so a bad id returns a clean 404 instead of
	// leaking the underlying foreign-key constraint error as a 500.
	var exists int
	if err := p.deps.DB.GetContext(r.Context(), &exists,
		`SELECT 1 FROM servers WHERE id = $1`, sid); err != nil {
		writeErr(w, 404, errUnknownServer)
		return
	}
	now := p.now().UTC()
	if _, err := p.deps.DB.ExecContext(r.Context(), `
		INSERT INTO sshaudit_hosts (server_id, enabled, poll_interval_seconds, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (server_id) DO UPDATE SET
			enabled = excluded.enabled,
			poll_interval_seconds = excluded.poll_interval_seconds,
			updated_at = excluded.updated_at`,
		sid, b.Enabled, interval, now); err != nil {
		writeErr(w, 500, err)
		return
	}
	// On enable, kick an immediate async collect (non-blocking, best-effort).
	if b.Enabled {
		p.kickCollect(p.deps, sid)
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// liveSessions runs `who` on the host on-demand and returns parsed sessions.
func (p *Plugin) liveSessions(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if p.deps.HostExec == nil {
		writeErr(w, 502, errors.New("host exec unavailable"))
		return
	}
	stdout, _, code, err := p.deps.HostExec.RunCmd(r.Context(), sid, "who")
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	if code != 0 {
		writeErr(w, 502, errors.New("who exited non-zero on host"))
		return
	}
	writeJSON(w, 200, map[string]any{
		"collected_at": p.now().UTC().Format(time.RFC3339),
		"sessions":     parseWho(string(stdout)),
	})
}

func (p *Plugin) listEvents(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	q := r.URL.Query()
	result := q.Get("result")
	if result == "" {
		result = "all"
	}
	if result != "all" && result != "accepted" && result != "failed" {
		writeErr(w, 400, errors.New("result must be accepted|failed|all"))
		return
	}
	limit := clampLimit(q.Get("limit"))
	rows, err := queryEvents(r.Context(), p.deps.DB, sid, result, limit)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, rows)
}

func (p *Plugin) getSummary(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	s, err := buildSummary(r.Context(), p.deps.DB, sid, p.now().UTC())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, s)
}

// collectNow runs a synchronous collect and reports how many rows were
// inserted. 502 on host/agent failure.
func (p *Plugin) collectNow(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	inserted, err := p.collectHost(r.Context(), p.deps, sid)
	if err != nil {
		writeErr(w, 502, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "inserted": inserted})
}

// ── helpers ─────────────────────────────────────────────────────────────────

// now returns the injectable clock, defaulting to time.Now when deps didn't
// supply one (e.g. minimal test deps).
func (p *Plugin) now() time.Time {
	if p.deps.Now != nil {
		return p.deps.Now()
	}
	return time.Now()
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	httpjson.Write(w, code, v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	httpjson.Error(w, code, err.Error())
}
