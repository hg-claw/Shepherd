package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
)

type PublicAPI struct {
	Servers  *serversvc.Service
	Settings *serversvc.SettingsStore
	Query    *telemetrysvc.Query
	Hub      *agentsvc.Hub
	Tokens   *agentsvc.Service // for AgentStatus token lookup
	statusLimit *tokenRateLimiter
}

// InitRateLimit configures the per-token rate limit for AgentStatus.
// Called once at startup; tests set their own via direct field access.
func (a *PublicAPI) InitRateLimit(max int, window time.Duration) {
	a.statusLimit = newTokenRateLimiter(max, window)
}

type publicCard struct {
	ID          int64   `json:"id"`
	Alias       string  `json:"alias"`
	Group       string  `json:"group"`
	CountryCode string  `json:"country_code"`
	Online      bool    `json:"online"`
	Latest      *latest `json:"latest,omitempty"`
}

type latest struct {
	TS       time.Time `json:"ts"`
	CPUPct   float64   `json:"cpu_pct"`
	MemPct   float64   `json:"mem_pct"`
	DisksPct []float64 `json:"disks_pct"`
	NetRxBps int64     `json:"net_rx_bps"`
	NetTxBps int64     `json:"net_tx_bps"`
	Load1    float64   `json:"load_1"`
	TCPConn  int       `json:"tcp_conn"`
}

func (a *PublicAPI) Servers_ListPublic(w http.ResponseWriter, r *http.Request) {
	all, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	intervalStr, _ := a.Settings.Get(r.Context(), "default_telemetry_interval_seconds")
	intervalSecs, _ := strconv.Atoi(intervalStr)
	if intervalSecs <= 0 {
		intervalSecs = 30
	}
	threshold := time.Duration(intervalSecs*3) * time.Second
	if threshold < 90*time.Second {
		threshold = 90 * time.Second
	}

	out := []publicCard{}
	for _, s := range all {
		if !s.ShowOnPublic {
			continue
		}
		// public_alias is the desensitized display name; if the admin didn't
		// set one, fall back to the server's internal name. The desensitization
		// is opt-in: toggling show_on_public alone should make it visible.
		alias := s.PublicAlias.String
		if !s.PublicAlias.Valid || alias == "" {
			alias = s.Name
		}
		card := publicCard{
			ID:          s.ID,
			Alias:       alias,
			Group:       s.PublicGroup.String,
			CountryCode: s.CountryCode.String,
			Online:      s.AgentLastSeen.Valid && time.Since(s.AgentLastSeen.Time) <= threshold,
		}
		if pt, err := a.Query.Latest(r.Context(), s.ID); err == nil && pt != nil {
			card.Latest = renderLatest(pt)
		}
		out = append(out, card)
	}
	writeJSON(w, 200, out)
}

func renderLatest(p *telemetrysvc.Point) *latest {
	l := &latest{}
	l.TS = p.TS
	if p.CPU != nil {
		l.CPUPct = *p.CPU
	}
	if p.MemUsed != nil && p.MemTotal != nil && *p.MemTotal > 0 {
		l.MemPct = float64(*p.MemUsed) / float64(*p.MemTotal) * 100
	}
	if p.Load1 != nil {
		l.Load1 = *p.Load1
	}
	if p.NetRxBps != nil {
		l.NetRxBps = *p.NetRxBps
	}
	if p.NetTxBps != nil {
		l.NetTxBps = *p.NetTxBps
	}
	if p.TCPConn != nil {
		l.TCPConn = *p.TCPConn
	}
	if p.DisksJSON != nil {
		var disks []struct {
			Used  int64 `json:"used"`
			Total int64 `json:"total"`
		}
		if err := json.Unmarshal([]byte(*p.DisksJSON), &disks); err == nil {
			for _, d := range disks {
				if d.Total > 0 {
					l.DisksPct = append(l.DisksPct, float64(d.Used)/float64(d.Total)*100)
				}
			}
		}
	}
	return l
}

func (a *PublicAPI) Telemetry(w http.ResponseWriter, r *http.Request) {
	const prefix = "/api/public/servers/"
	const suffix = "/telemetry"
	if !strings.HasPrefix(r.URL.Path, prefix) || !strings.HasSuffix(r.URL.Path, suffix) {
		writeError(w, 400, "bad path")
		return
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, prefix), suffix)
	id, err := strconv.ParseInt(mid, 10, 64)
	if err != nil {
		writeError(w, 400, "bad id")
		return
	}
	srv, err := a.Servers.Get(r.Context(), id)
	if err != nil || !srv.ShowOnPublic {
		writeError(w, 404, "not found")
		return
	}
	rng := telemetrysvc.Range(r.URL.Query().Get("range"))
	pts, err := a.Query.Series(r.Context(), id, rng)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, pts)
}

func (a *PublicAPI) GetSettings(w http.ResponseWriter, r *http.Request) {
	mode, _ := a.Settings.Get(r.Context(), "public_display_mode")
	if mode == "" {
		mode = "both"
	}
	writeJSON(w, 200, map[string]string{"public_display_mode": mode})
}

// AgentStatus is a public, token-authenticated endpoint used by the
// install script to verify the agent has connected. Returns 404 for
// unknown / expired tokens, 429 when the per-token rate limit is hit,
// and 200 with {online, last_seen_at} otherwise.
//
// `online` is true if agent_last_seen is non-null and within the last 60s.
func (a *PublicAPI) AgentStatus(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if token == "" {
		writeError(w, 400, "token required")
		return
	}
	if a.statusLimit != nil && !a.statusLimit.allow(token) {
		writeError(w, 429, "rate limit exceeded")
		return
	}
	serverID, err := a.Tokens.LookupEnrollment(r.Context(), token)
	if err != nil {
		writeError(w, 404, "unknown or expired token")
		return
	}
	srv, err := a.Servers.Get(r.Context(), serverID)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	online := srv.AgentLastSeen.Valid &&
		time.Since(srv.AgentLastSeen.Time) <= 60*time.Second
	var lastSeenAt *string
	if srv.AgentLastSeen.Valid {
		s := srv.AgentLastSeen.Time.UTC().Format(time.RFC3339)
		lastSeenAt = &s
	}
	writeJSON(w, 200, map[string]any{
		"online":       online,
		"last_seen_at": lastSeenAt,
	})
}
