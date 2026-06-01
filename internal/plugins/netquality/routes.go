package netquality

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/httpjson"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

// All admin endpoints are mounted at /api/admin/plugins/netquality
// (handled by the gated mux in router.go). Auth is the admin session
// cookie — the gate is opaque to handlers here.

// RegisterRoutes wires every netquality admin REST endpoint.
func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	p.deps = deps

	// Targets catalog. List, create, patch (enable/disable + label tweak),
	// delete (custom only — builtin rows are disabled via PATCH instead so
	// historical samples still resolve a label).
	mux.HandleFunc("GET /targets", p.listTargets)
	mux.HandleFunc("POST /targets", p.createCustomTarget)
	mux.HandleFunc("PATCH /targets/{id}", p.patchTarget)
	mux.HandleFunc("DELETE /targets/{id}", p.deleteCustomTarget)

	// Per-host config. List + upsert. The upsert kicks PushConfig so the
	// agent picks up the new plan without waiting for its next WS reconnect.
	mux.HandleFunc("GET /hosts", p.listHosts)
	mux.HandleFunc("PUT /hosts/{server_id}", p.upsertHost)
	// Per-host target opt-in. GET returns every globally-enabled target
	// with a 'selected' flag for this host; PUT replaces the host's set.
	mux.HandleFunc("GET /hosts/{server_id}/targets", p.listHostTargets)
	mux.HandleFunc("PUT /hosts/{server_id}/targets", p.putHostTargets)

	// Sample history. Mirrors singbox traffic's resolution-by-span heuristic:
	// short span → raw, medium → minute, long → hour. Resolution can be
	// overridden via ?resolution=raw|minute|hour.
	mux.HandleFunc("GET /samples", p.querySamples)
	mux.HandleFunc("GET /samples/latest", p.latestPerTarget)
}

// targetRow is the JSON shape returned by /targets endpoints.
type targetRow struct {
	ID        int64     `db:"id"         json:"id"`
	Source    string    `db:"source"     json:"source"`
	ISP       string    `db:"isp"        json:"isp"`
	Region    string    `db:"region"     json:"region"`
	Label     string    `db:"label"      json:"label"`
	Host      string    `db:"host"       json:"host"`
	Enabled   bool      `db:"enabled"    json:"enabled"`
	CreatedAt time.Time `db:"created_at" json:"created_at"`
}

func (p *Plugin) listTargets(w http.ResponseWriter, r *http.Request) {
	var rows []targetRow
	if err := p.deps.DB.SelectContext(r.Context(), &rows, `
		SELECT id, source, isp, region, label, host, enabled, created_at
		  FROM netquality_targets ORDER BY isp, region, label`); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, rows)
}

type createTargetBody struct {
	ISP    string `json:"isp"`
	Region string `json:"region"`
	Label  string `json:"label"`
	Host   string `json:"host"`
}

func (p *Plugin) createCustomTarget(w http.ResponseWriter, r *http.Request) {
	var b createTargetBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	if b.Host == "" || b.Label == "" {
		writeErr(w, 400, errors.New("host and label required"))
		return
	}
	if !validISP(b.ISP) {
		writeErr(w, 400, errors.New("isp must be one of telecom|unicom|mobile|overseas"))
		return
	}
	if b.Region == "" {
		b.Region = "Custom"
	}
	now := time.Now().UTC()
	if _, err := p.deps.DB.ExecContext(r.Context(), `
		INSERT INTO netquality_targets
		  (source, isp, region, label, host, enabled, created_at)
		VALUES ('custom', $1, $2, $3, $4, true, $5)`,
		b.ISP, b.Region, b.Label, b.Host, now); err != nil {
		writeErr(w, 500, err)
		return
	}
	// Fan-out: every currently-enabled host re-receives the catalog so
	// the new target enters its sampling plan without waiting for reconnect.
	p.pushAllEnabledHosts(r.Context())
	writeJSON(w, 201, map[string]any{"ok": true})
}

type patchTargetBody struct {
	Enabled *bool   `json:"enabled,omitempty"`
	Label   *string `json:"label,omitempty"`
}

func (p *Plugin) patchTarget(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var b patchTargetBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	sets := []string{}
	args := []any{}
	idx := 1
	if b.Enabled != nil {
		sets = append(sets, "enabled = $"+strconv.Itoa(idx))
		args = append(args, *b.Enabled)
		idx++
	}
	if b.Label != nil {
		sets = append(sets, "label = $"+strconv.Itoa(idx))
		args = append(args, *b.Label)
		idx++
	}
	if len(sets) == 0 {
		writeJSON(w, 200, map[string]any{"ok": true, "noop": true})
		return
	}
	args = append(args, id)
	q := "UPDATE netquality_targets SET " + strings.Join(sets, ", ") +
		" WHERE id = $" + strconv.Itoa(idx)
	if _, err := p.deps.DB.ExecContext(r.Context(), q, args...); err != nil {
		writeErr(w, 500, err)
		return
	}
	p.pushAllEnabledHosts(r.Context())
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (p *Plugin) deleteCustomTarget(w http.ResponseWriter, r *http.Request) {
	// We refuse to hard-delete builtin rows so historical samples still
	// join back to a label. The UI offers "disable" for builtins instead.
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	res, err := p.deps.DB.ExecContext(r.Context(),
		`DELETE FROM netquality_targets WHERE id = $1 AND source = 'custom'`, id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		writeErr(w, 404, errors.New("target not found or not deletable (builtins use PATCH enabled=false)"))
		return
	}
	p.pushAllEnabledHosts(r.Context())
	writeJSON(w, 200, map[string]any{"ok": true})
}

type hostRow struct {
	ServerID              int64      `db:"server_id"               json:"server_id"`
	Enabled               bool       `db:"enabled"                 json:"enabled"`
	SampleIntervalSeconds int        `db:"sample_interval_seconds" json:"sample_interval_seconds"`
	LastError             *string    `db:"last_error"              json:"last_error,omitempty"`
	UpdatedAt             *time.Time `db:"updated_at"              json:"updated_at,omitempty"`
}

func (p *Plugin) listHosts(w http.ResponseWriter, r *http.Request) {
	var rows []hostRow
	if err := p.deps.DB.SelectContext(r.Context(), &rows, `
		SELECT server_id, enabled, sample_interval_seconds, last_error, updated_at
		  FROM netquality_hosts ORDER BY server_id`); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, rows)
}

type upsertHostBody struct {
	Enabled               bool `json:"enabled"`
	SampleIntervalSeconds int  `json:"sample_interval_seconds"`
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
	if b.SampleIntervalSeconds <= 0 {
		b.SampleIntervalSeconds = 300
	}
	now := time.Now().UTC()
	// We need to know whether this is the first enable transition, so
	// the seed-on-first-enable below only fires when there's actually
	// nothing in netquality_host_targets yet (rather than once per
	// upsert, which would re-create rows the operator just removed).
	var prevEnabled bool
	hadRow := true
	if err := p.deps.DB.GetContext(r.Context(), &prevEnabled,
		`SELECT enabled FROM netquality_hosts WHERE server_id=$1`, sid); err != nil {
		hadRow = false
	}
	if _, err := p.deps.DB.ExecContext(r.Context(), `
		INSERT INTO netquality_hosts (server_id, enabled, sample_interval_seconds, updated_at)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (server_id) DO UPDATE SET
			enabled = excluded.enabled,
			sample_interval_seconds = excluded.sample_interval_seconds,
			updated_at = excluded.updated_at`,
		sid, b.Enabled, b.SampleIntervalSeconds, now); err != nil {
		writeErr(w, 500, err)
		return
	}
	// First-enable transition: hadRow=false (brand-new host) OR
	// hadRow=true but prevEnabled=false. In both cases seed the per-host
	// target set with everything globally enabled, so the operator gets
	// the legacy "every target" behaviour without an extra click.
	// Subsequent flips don't re-seed — that would clobber operator edits.
	firstEnable := b.Enabled && (!hadRow || !prevEnabled)
	if firstEnable {
		if err := seedHostTargets(r.Context(), p.deps.DB, sid); err != nil {
			// Non-fatal: host is configured, just no targets yet. The
			// operator can pick them via PUT /hosts/{id}/targets.
			// (We surface this via the response so the UI can flag it.)
			writeJSON(w, 200, map[string]any{"ok": true, "warning": "target seed failed: " + err.Error()})
			return
		}
	}
	PushConfig(r.Context(), p.deps.DB, p.deps.HubSend, sid)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// seedHostTargets fills netquality_host_targets for a server with every
// globally-enabled target. Called once on first enable. Idempotent via
// the PK; an operator who has already curated their set won't see rows
// reappear.
func seedHostTargets(ctx context.Context, db *sqlx.DB, serverID int64) error {
	_, err := db.ExecContext(ctx, `
		INSERT INTO netquality_host_targets (server_id, target_id, enabled)
		SELECT $1, id, true FROM netquality_targets WHERE enabled = true
		ON CONFLICT (server_id, target_id) DO NOTHING`,
		serverID)
	return err
}

// hostTargetRow combines the catalog row with the per-host selection so
// the UI can render "every available target with a checkbox" in one
// payload.
type hostTargetRow struct {
	TargetID int64  `db:"target_id" json:"target_id"`
	ISP      string `db:"isp"       json:"isp"`
	Region   string `db:"region"    json:"region"`
	Label    string `db:"label"     json:"label"`
	Host     string `db:"host"      json:"host"`
	Selected bool   `db:"selected"  json:"selected"`
}

func (p *Plugin) listHostTargets(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	// COALESCE makes "no row at all" equivalent to "selected=false" so the
	// UI shows the operator the entire catalog as a single picker.
	var rows []hostTargetRow
	if err := p.deps.DB.SelectContext(r.Context(), &rows, `
		SELECT t.id AS target_id, t.isp, t.region, t.label, t.host,
		       COALESCE(ht.enabled, false) AS selected
		  FROM netquality_targets t
		  LEFT JOIN netquality_host_targets ht
		    ON ht.target_id = t.id AND ht.server_id = $1
		 WHERE t.enabled = true
		 ORDER BY t.isp, t.region, t.label`, sid); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, rows)
}

type putHostTargetsBody struct {
	TargetIDs []int64 `json:"target_ids"`
}

func (p *Plugin) putHostTargets(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.PathValue("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var b putHostTargetsBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	// Idempotent replace: wipe then insert. One transaction so a
	// half-written set doesn't leak to the next PushConfig.
	tx, err := p.deps.DB.BeginTxx(r.Context(), nil)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(r.Context(),
		`DELETE FROM netquality_host_targets WHERE server_id=$1`, sid); err != nil {
		writeErr(w, 500, err)
		return
	}
	for _, tid := range b.TargetIDs {
		if _, err := tx.ExecContext(r.Context(),
			`INSERT INTO netquality_host_targets (server_id, target_id, enabled) VALUES ($1, $2, true)`,
			sid, tid); err != nil {
			writeErr(w, 500, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, 500, err)
		return
	}
	PushConfig(r.Context(), p.deps.DB, p.deps.HubSend, sid)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// querySamples handles GET /samples?server_id=X&target_id=Y&from=ts&to=ts[&resolution=raw|minute|hour]
// Returns a flat list of {ts, rtt_avg_ms, loss_pct, status?}. The status
// column is only present in the raw table so we omit it for minute/hour.
func (p *Plugin) querySamples(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	serverID, err := strconv.ParseInt(q.Get("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, errors.New("server_id required"))
		return
	}
	targetID, err := strconv.ParseInt(q.Get("target_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, errors.New("target_id required"))
		return
	}
	from, err := time.Parse(time.RFC3339, q.Get("from"))
	if err != nil {
		writeErr(w, 400, errors.New("from must be RFC3339"))
		return
	}
	to, err := time.Parse(time.RFC3339, q.Get("to"))
	if err != nil {
		writeErr(w, 400, errors.New("to must be RFC3339"))
		return
	}
	res := q.Get("resolution")
	if res == "" {
		span := to.Sub(from)
		switch {
		case span <= 2*time.Hour:
			res = "raw"
		case span <= 7*24*time.Hour:
			res = "minute"
		default:
			res = "hour"
		}
	}
	table := tableForResolution(res)
	if table == "" {
		writeErr(w, 400, errors.New("resolution must be raw|minute|hour"))
		return
	}
	rows, err := queryPoints(r.Context(), p.deps.DB, table, serverID, targetID, from, to)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"resolution": res, "points": rows})
}

// latestPerTarget powers the per-server grid view: one row per
// enabled target with its newest raw sample.
func (p *Plugin) latestPerTarget(w http.ResponseWriter, r *http.Request) {
	sid, err := strconv.ParseInt(r.URL.Query().Get("server_id"), 10, 64)
	if err != nil {
		writeErr(w, 400, errors.New("server_id required"))
		return
	}
	type row struct {
		TargetID int64      `db:"target_id"  json:"target_id"`
		ISP      string     `db:"isp"        json:"isp"`
		Region   string     `db:"region"     json:"region"`
		Label    string     `db:"label"      json:"label"`
		TS       *time.Time `db:"ts"         json:"ts,omitempty"`
		RTTAvgMs *float64   `db:"rtt_avg_ms" json:"rtt_avg_ms,omitempty"`
		LossPct  *float64   `db:"loss_pct"   json:"loss_pct,omitempty"`
		Status   *string    `db:"status"     json:"status,omitempty"`
	}
	// For each enabled target return the freshest raw sample for this
	// server. Correlated subquery is cheaper than a window function and
	// stays portable across sqlite + postgres.
	var rows []row
	if err := p.deps.DB.SelectContext(r.Context(), &rows, `
		SELECT
		  t.id AS target_id, t.isp, t.region, t.label,
		  s.ts, s.rtt_avg_ms, s.loss_pct, s.status
		FROM netquality_targets t
		LEFT JOIN netquality_samples_raw s
		  ON s.target_id = t.id AND s.server_id = $1
		 AND s.ts = (SELECT MAX(ts) FROM netquality_samples_raw
		             WHERE target_id = t.id AND server_id = $1)
		WHERE t.enabled = true
		ORDER BY t.isp, t.region, t.label`, sid); err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, rows)
}

// pushAllEnabledHosts re-pushes the catalog/cadence to every server that
// currently has the plugin enabled. Called from the target CRUD paths so
// catalog edits propagate without waiting for reconnect.
func (p *Plugin) pushAllEnabledHosts(ctx context.Context) {
	var ids []int64
	_ = p.deps.DB.SelectContext(ctx, &ids,
		`SELECT server_id FROM netquality_hosts WHERE enabled = true`)
	for _, id := range ids {
		PushConfig(ctx, p.deps.DB, p.deps.HubSend, id)
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func tableForResolution(res string) string {
	switch res {
	case "raw":
		return "netquality_samples_raw"
	case "minute":
		return "netquality_samples_minute"
	case "hour":
		return "netquality_samples_hour"
	}
	return ""
}

func queryPoints(ctx context.Context, db *sqlx.DB, table string, serverID, targetID int64, from, to time.Time) ([]map[string]any, error) {
	// raw has rtt_min/max/jitter/status, the rollups don't. Build the
	// projection to match — the JSON shape stays consistent (omitempty
	// hides the absent columns on the wire).
	cols := "ts, rtt_avg_ms, loss_pct"
	if table == "netquality_samples_raw" {
		cols += ", rtt_min_ms, rtt_max_ms, jitter_ms, status"
	} else {
		cols += ", samples"
	}
	rows, err := db.QueryxContext(ctx,
		"SELECT "+cols+" FROM "+table+
			" WHERE server_id=$1 AND target_id=$2 AND ts BETWEEN $3 AND $4 ORDER BY ts ASC",
		serverID, targetID, from.UTC(), to.UTC())
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []map[string]any{}
	for rows.Next() {
		m := map[string]any{}
		if err := rows.MapScan(m); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func validISP(s string) bool {
	switch s {
	case "telecom", "unicom", "mobile", "overseas":
		return true
	}
	return false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	httpjson.Write(w, code, v)
}

func writeErr(w http.ResponseWriter, code int, err error) {
	httpjson.Error(w, code, err.Error())
}
