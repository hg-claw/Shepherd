package sshaudit

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

const (
	retentionDays   = 30
	defaultLookback = 24 * time.Hour
	summaryWindow   = 24 * time.Hour
)

// hostConfig is the persisted per-server row.
type hostConfig struct {
	ServerID            int64      `db:"server_id"`
	Enabled             bool       `db:"enabled"`
	PollIntervalSeconds int        `db:"poll_interval_seconds"`
	CursorTS            *time.Time `db:"cursor_ts"`
	LastCollectAt       *time.Time `db:"last_collect_at"`
	LastError           *string    `db:"last_error"`
	UpdatedAt           time.Time  `db:"updated_at"`
}

// getHost loads one host's config row, or ok=false when absent.
func getHost(ctx context.Context, db *sqlx.DB, serverID int64) (hostConfig, bool, error) {
	var h hostConfig
	err := db.GetContext(ctx, &h, `
		SELECT server_id, enabled, poll_interval_seconds, cursor_ts,
		       last_collect_at, last_error, updated_at
		  FROM sshaudit_hosts WHERE server_id = $1`, serverID)
	if err != nil {
		// sql.ErrNoRows surfaces here; treat as "no row".
		return hostConfig{}, false, nil
	}
	return h, true, nil
}

// collectHost runs the host-side log commands, parses sshd auth lines, and
// persists new events idempotently. Returns the number of rows actually
// inserted. It advances the cursor to the newest event ts seen and stamps
// last_collect_at/last_error. Never moves the cursor backwards.
//
// This is the test seam: unit tests call it directly with a fake HostExec.
func (p *Plugin) collectHost(ctx context.Context, deps plugins.Deps, serverID int64) (inserted int, err error) {
	now := deps.Now().UTC()

	host, _, _ := getHost(ctx, deps.DB, serverID)
	since := now.Add(-defaultLookback)
	if host.CursorTS != nil && host.CursorTS.After(since) {
		since = host.CursorTS.UTC()
	}

	events, collectErr := p.gatherEvents(ctx, deps, serverID, since, now)
	if collectErr != nil {
		_ = stampCollect(ctx, deps.DB, serverID, now, collectErr.Error(), nil)
		return 0, collectErr
	}

	// Filter to events strictly newer than the cursor so the auth.log
	// fallback (which re-reads the whole tail) doesn't re-offer already
	// stored rows. journalctl --since already bounds this, but filtering
	// here keeps both paths consistent.
	var maxTS *time.Time
	for i := range events {
		ev := &events[i]
		if host.CursorTS != nil && !ev.TS.After(host.CursorTS.UTC()) {
			continue
		}
		n, ierr := insertEvent(ctx, deps.DB, serverID, ev, now)
		if ierr != nil {
			_ = stampCollect(ctx, deps.DB, serverID, now, ierr.Error(), nil)
			return inserted, ierr
		}
		inserted += n
		if maxTS == nil || ev.TS.After(*maxTS) {
			t := ev.TS
			maxTS = &t
		}
	}

	// Advance cursor only forward.
	newCursor := host.CursorTS
	if maxTS != nil && (newCursor == nil || maxTS.After(newCursor.UTC())) {
		newCursor = maxTS
	}
	if err := stampCollect(ctx, deps.DB, serverID, now, "", newCursor); err != nil {
		return inserted, err
	}

	// Retention prune (best-effort; a failure here shouldn't fail collect).
	cutoff := now.Add(-retentionDays * 24 * time.Hour)
	_, _ = deps.DB.ExecContext(ctx,
		`DELETE FROM sshaudit_events WHERE server_id = $1 AND ts < $2`, serverID, cutoff)

	return inserted, nil
}

// gatherEvents runs the host commands and returns parsed events. Prefers
// journalctl; falls back to cat'ing the auth logs when journalctl is absent
// or empty. ref pins the syslog Dec→Jan rollover against the injected clock
// so collection is deterministic in tests.
func (p *Plugin) gatherEvents(ctx context.Context, deps plugins.Deps, serverID int64, since, ref time.Time) ([]Event, error) {
	if deps.HostExec == nil {
		return nil, fmt.Errorf("host exec unavailable")
	}
	loc := time.UTC

	sinceStr := since.Format("2006-01-02 15:04:05")
	stdout, _, code, err := deps.HostExec.RunCmd(ctx, serverID,
		"journalctl", "_COMM=sshd", "-o", "short-iso", "--no-pager", "-q", "--since", sinceStr)
	if err != nil {
		return nil, err
	}
	if code == 0 && len(strings.TrimSpace(string(stdout))) > 0 {
		return parseLinesAt(string(stdout), ref, loc), nil
	}

	// Fallback: read the syslog auth files.
	out2, _, _, err := deps.HostExec.RunCmd(ctx, serverID,
		"sh", "-c", "cat /var/log/auth.log /var/log/secure 2>/dev/null | tail -n 2000")
	if err != nil {
		return nil, err
	}
	return parseLinesAt(string(out2), ref, loc), nil
}

// insertEvent inserts one event idempotently (INSERT OR IGNORE on sqlite,
// ON CONFLICT DO NOTHING on postgres — both expressed as ON CONFLICT here,
// which sqlite's UNIQUE supports). Returns 1 when a row was inserted, 0 on
// conflict.
func insertEvent(ctx context.Context, db *sqlx.DB, serverID int64, ev *Event, now time.Time) (int, error) {
	res, err := db.ExecContext(ctx, `
		INSERT INTO sshaudit_events
		  (server_id, ts, result, method, invalid_user, username, source_ip, port, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT DO NOTHING`,
		serverID, ev.TS.UTC(), ev.Result, ev.Method, ev.InvalidUser,
		ev.Username, ev.SourceIP, ev.Port, now)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// stampCollect updates last_collect_at, last_error, and (when cursor is
// non-nil) cursor_ts. lastErr == "" clears the error. Upserts the row so a
// collect kicked before the first PUT still records state.
func stampCollect(ctx context.Context, db *sqlx.DB, serverID int64, now time.Time, lastErr string, cursor *time.Time) error {
	var errVal any
	if lastErr != "" {
		errVal = lastErr
	}
	_, err := db.ExecContext(ctx, `
		INSERT INTO sshaudit_hosts
		  (server_id, enabled, poll_interval_seconds, cursor_ts, last_collect_at, last_error, updated_at)
		VALUES ($1, false, 300, $2, $3, $4, $5)
		ON CONFLICT (server_id) DO UPDATE SET
			cursor_ts       = COALESCE(excluded.cursor_ts, sshaudit_hosts.cursor_ts),
			last_collect_at = excluded.last_collect_at,
			last_error      = excluded.last_error,
			updated_at      = excluded.updated_at`,
		serverID, cursor, now, errVal, now)
	return err
}

// ── read-side helpers (events / summary) ──────────────────────────────────

type eventRow struct {
	ID          int64     `db:"id"           json:"id"`
	TS          time.Time `db:"ts"           json:"ts"`
	Result      string    `db:"result"       json:"result"`
	Method      string    `db:"method"       json:"method"`
	InvalidUser bool      `db:"invalid_user" json:"invalid_user"`
	Username    string    `db:"username"     json:"username"`
	SourceIP    string    `db:"source_ip"    json:"source_ip"`
	Port        *int      `db:"port"         json:"port"`
}

// queryEvents returns stored events newest-first, optionally filtered by
// result ("accepted"|"failed"|"all"), capped at limit.
func queryEvents(ctx context.Context, db *sqlx.DB, serverID int64, result string, limit int) ([]eventRow, error) {
	rows := []eventRow{}
	q := `SELECT id, ts, result, method, invalid_user, username, source_ip, port
	        FROM sshaudit_events WHERE server_id = $1`
	args := []any{serverID}
	if result == "accepted" || result == "failed" {
		q += ` AND result = $2`
		args = append(args, result)
		q += ` ORDER BY ts DESC, id DESC LIMIT $3`
		args = append(args, limit)
	} else {
		q += ` ORDER BY ts DESC, id DESC LIMIT $2`
		args = append(args, limit)
	}
	if err := db.SelectContext(ctx, &rows, q, args...); err != nil {
		return nil, err
	}
	return rows, nil
}

type sourceStat struct {
	SourceIP string `json:"source_ip"`
	Count    int    `json:"count"`
	LastTS   string `json:"last_ts"` // RFC3339; the contract wants a string
}

type userStat struct {
	Username string `db:"username" json:"username"`
	Count    int    `db:"count"    json:"count"`
}

type summary struct {
	WindowHours     int          `json:"window_hours"`
	Accepted        int          `json:"accepted"`
	Failed          int          `json:"failed"`
	UniqueSourceIPs int          `json:"unique_source_ips"`
	TopSources      []sourceStat `json:"top_sources"`
	TopFailedUsers  []userStat   `json:"top_failed_users"`
}

// buildSummary aggregates the last 24h of stored events for a server.
func buildSummary(ctx context.Context, db *sqlx.DB, serverID int64, now time.Time) (summary, error) {
	since := now.Add(-summaryWindow).UTC()
	s := summary{
		WindowHours:    int(summaryWindow / time.Hour),
		TopSources:     []sourceStat{},
		TopFailedUsers: []userStat{},
	}

	var counts []struct {
		Result string `db:"result"`
		N      int    `db:"n"`
	}
	if err := db.SelectContext(ctx, &counts, `
		SELECT result, COUNT(*) AS n FROM sshaudit_events
		 WHERE server_id = $1 AND ts >= $2 GROUP BY result`, serverID, since); err != nil {
		return s, err
	}
	for _, c := range counts {
		switch c.Result {
		case "accepted":
			s.Accepted = c.N
		case "failed":
			s.Failed = c.N
		}
	}

	if err := db.GetContext(ctx, &s.UniqueSourceIPs, `
		SELECT COUNT(DISTINCT source_ip) FROM sshaudit_events
		 WHERE server_id = $1 AND ts >= $2 AND source_ip <> ''`, serverID, since); err != nil {
		return s, err
	}

	// Top sources use MapScan rather than struct scan: MAX(ts) loses the
	// column's time affinity in sqlite (returns TEXT) while postgres returns
	// a time.Time. MapScan + normalizeTS handles both into an RFC3339 string.
	srcRows, err := db.QueryxContext(ctx, `
		SELECT source_ip, COUNT(*) AS count, MAX(ts) AS last_ts
		  FROM sshaudit_events
		 WHERE server_id = $1 AND ts >= $2 AND source_ip <> ''
		 GROUP BY source_ip
		 ORDER BY count DESC, last_ts DESC
		 LIMIT 5`, serverID, since)
	if err != nil {
		return s, err
	}
	defer func() { _ = srcRows.Close() }()
	for srcRows.Next() {
		m := map[string]any{}
		if err := srcRows.MapScan(m); err != nil {
			return s, err
		}
		s.TopSources = append(s.TopSources, sourceStat{
			SourceIP: asString(m["source_ip"]),
			Count:    asInt(m["count"]),
			LastTS:   normalizeTS(m["last_ts"]),
		})
	}
	if err := srcRows.Err(); err != nil {
		return s, err
	}

	if err := db.SelectContext(ctx, &s.TopFailedUsers, `
		SELECT username, COUNT(*) AS count
		  FROM sshaudit_events
		 WHERE server_id = $1 AND ts >= $2 AND result = 'failed' AND username <> ''
		 GROUP BY username
		 ORDER BY count DESC
		 LIMIT 5`, serverID, since); err != nil {
		return s, err
	}
	return s, nil
}

// ── live sessions (who) ────────────────────────────────────────────────────

// session is one live login as reported by `who`.
type session struct {
	User     string `json:"user"`
	SourceIP string `json:"source_ip"`
	TTY      string `json:"tty"`
	LoginAt  string `json:"login_at"`
	PID      *int   `json:"pid"`
}

// parseWho parses `who` output. Each line looks like:
//
//	root     pts/0        2026-06-16 09:00 (1.2.3.4)
//	root     pts/1        2026-06-16 09:01          (local, no host)
//
// source_ip comes from the trailing "(host)"; empty when absent or when the
// host is a non-IP marker (e.g. ":0"). PID is not present in plain `who`
// output, so it stays nil here (the contract allows null).
func parseWho(text string) []session {
	out := []session{}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		s := session{User: f[0], TTY: f[1]}
		// The login timestamp is the remaining fields up to an optional
		// trailing "(host)" token. who prints "YYYY-MM-DD HH:MM" (2 tokens)
		// or the older "Mon DD HH:MM" (3 tokens). Capture everything that
		// isn't the parenthesized host.
		var loginParts []string
		for _, tok := range f[2:] {
			if strings.HasPrefix(tok, "(") && strings.HasSuffix(tok, ")") {
				host := strings.TrimSuffix(strings.TrimPrefix(tok, "("), ")")
				if isSourceHost(host) {
					s.SourceIP = host
				}
				continue
			}
			loginParts = append(loginParts, tok)
		}
		s.LoginAt = strings.Join(loginParts, " ")
		out = append(out, s)
	}
	return out
}

// isSourceHost filters out the local/display markers `who` emits in the
// host column (":0", ":0.0", "tmux(...)", etc.) so source_ip only carries a
// real remote host/IP.
func isSourceHost(h string) bool {
	if h == "" {
		return false
	}
	if strings.HasPrefix(h, ":") {
		return false // X display, e.g. ":0"
	}
	if strings.Contains(h, "(") {
		return false // tmux/screen markers
	}
	return true
}

// clampLimit applies the contract's default/cap for the events limit.
func clampLimit(raw string) int {
	const def, max = 200, 1000
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return def
	}
	if n > max {
		return max
	}
	return n
}

// ── MapScan normalizers (cross-driver aggregate scanning) ──────────────────

func asString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case []byte:
		return string(x)
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", x)
	}
}

func asInt(v any) int {
	switch x := v.(type) {
	case int64:
		return int(x)
	case int:
		return x
	case float64:
		return int(x)
	case []byte:
		n, _ := strconv.Atoi(string(x))
		return n
	case string:
		n, _ := strconv.Atoi(x)
		return n
	default:
		return 0
	}
}

// normalizeTS coerces whatever a driver returns for MAX(ts) into an RFC3339
// string. sqlite hands back a TEXT timestamp (various layouts); postgres a
// time.Time.
func normalizeTS(v any) string {
	switch x := v.(type) {
	case time.Time:
		return x.UTC().Format(time.RFC3339)
	case string:
		return reformatTS(x)
	case []byte:
		return reformatTS(string(x))
	default:
		return ""
	}
}

// reformatTS parses a sqlite-stored timestamp string and re-emits RFC3339.
// Falls back to the raw string when no known layout matches.
func reformatTS(s string) string {
	for _, layout := range []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05.999999999 -0700 UTC",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC().Format(time.RFC3339)
		}
	}
	return s
}
