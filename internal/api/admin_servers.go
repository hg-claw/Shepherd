package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/installer"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
)

type ServersAPI struct {
	Servers        *serversvc.Service
	Settings       *serversvc.SettingsStore
	Query          *telemetrysvc.Query
	Hub            *agentsvc.Hub
	InstallManager *serversvc.InstallManager
	Tokens         *agentsvc.Service // for repair
}

func (a *ServersAPI) List(w http.ResponseWriter, r *http.Request) {
	servers, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if r.URL.Query().Get("with") != "latest" {
		writeJSON(w, 200, servers)
		return
	}
	type wrapped struct {
		*serversvc.Server
		Latest *telemetrysvc.Point `json:"latest"`
	}
	out := make([]wrapped, 0, len(servers))
	for _, s := range servers {
		pt, _ := a.Query.Latest(r.Context(), s.ID) // nil if no telemetry yet — fine
		out = append(out, wrapped{Server: s, Latest: pt})
	}
	writeJSON(w, 200, out)
}

type createReq struct {
	Name         string `json:"name"`
	PublicAlias  string `json:"public_alias"`
	PublicGroup  string `json:"public_group"`
	CountryCode  string `json:"country_code"`
	ShowOnPublic bool   `json:"show_on_public"`
}

func (a *ServersAPI) Create(w http.ResponseWriter, r *http.Request) {
	var in createReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, 400, "name required")
		return
	}
	srv, err := a.Servers.Create(r.Context(), serversvc.CreateInput{
		Name: in.Name, PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, srv)
}

func (a *ServersAPI) Get(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	srv, err := a.Servers.Get(r.Context(), id)
	if errors.Is(err, serversvc.ErrNotFound) {
		writeError(w, 404, "not found")
		return
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, srv)
}

type patchReq struct {
	Name         *string `json:"name"`
	PublicAlias  *string `json:"public_alias"`
	PublicGroup  *string `json:"public_group"`
	CountryCode  *string `json:"country_code"`
	ShowOnPublic *bool   `json:"show_on_public"`
}

func (a *ServersAPI) Patch(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	var in patchReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	srv, err := a.Servers.Patch(r.Context(), id, serversvc.PatchInput{
		Name: in.Name, PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if errors.Is(err, serversvc.ErrNotFound) {
		writeError(w, 404, "not found")
		return
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, srv)
}

func (a *ServersAPI) Delete(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	if err := a.Servers.Delete(r.Context(), id); err != nil {
		if errors.Is(err, serversvc.ErrNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pathID extracts the trailing numeric segment after `prefix`. Returns (0,false) if
// the request path doesn't match `prefix<digits>` (no trailing slash, no extra segments).
func pathID(r *http.Request, prefix string) (int64, bool) {
	if !strings.HasPrefix(r.URL.Path, prefix) {
		return 0, false
	}
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	if rest == "" || strings.ContainsRune(rest, '/') {
		return 0, false
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

func (a *ServersAPI) Telemetry(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/telemetry")
	if !ok {
		writeError(w, 400, "bad path")
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

// pathID2 extracts the numeric segment between two fixed wrappers.
//
//	pathID2(r, "/api/servers/", "/telemetry") on "/api/servers/42/telemetry" -> 42, true
func pathID2(r *http.Request, prefix, suffix string) (int64, bool) {
	p := r.URL.Path
	if !strings.HasPrefix(p, prefix) || !strings.HasSuffix(p, suffix) {
		return 0, false
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(p, prefix), suffix)
	if mid == "" || strings.ContainsRune(mid, '/') {
		return 0, false
	}
	id, err := strconv.ParseInt(mid, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}

type installReq struct {
	Name         string `json:"name"`
	SSHHost      string `json:"ssh_host"`
	SSHPort      int    `json:"ssh_port"`
	SSHUser      string `json:"ssh_user"`
	SSHPassword  string `json:"ssh_password"`
	SSHKey       string `json:"ssh_key"`
	Arch         string `json:"arch"` // amd64|arm64
	PublicAlias  string `json:"public_alias"`
	PublicGroup  string `json:"public_group"`
	CountryCode  string `json:"country_code"`
	ShowOnPublic bool   `json:"show_on_public"`
}

func (a *ServersAPI) Install(w http.ResponseWriter, r *http.Request) {
	var in installReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(in.Name) == "" || strings.TrimSpace(in.SSHHost) == "" || strings.TrimSpace(in.SSHUser) == "" {
		writeError(w, 400, "name, ssh_host, ssh_user required")
		return
	}
	if in.SSHPassword == "" && in.SSHKey == "" {
		writeError(w, 400, "one of ssh_password or ssh_key required")
		return
	}
	if in.Arch != "amd64" && in.Arch != "arm64" {
		writeError(w, 400, "arch must be amd64 or arm64")
		return
	}
	srv, err := a.Servers.Create(r.Context(), serversvc.CreateInput{
		Name: in.Name, SSHHost: in.SSHHost, SSHPort: in.SSHPort, SSHUser: in.SSHUser,
		PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	creds := installerCreds(in)
	a.InstallManager.Start(serversvc.InstallRequest{Server: srv, Creds: creds, Arch: in.Arch})
	writeJSON(w, 202, map[string]any{"server_id": srv.ID})
}

func installerCreds(in installReq) installer.SSHCredentials {
	creds := installer.SSHCredentials{Host: in.SSHHost, Port: in.SSHPort, User: in.SSHUser, Password: in.SSHPassword}
	if creds.Port == 0 {
		creds.Port = 22
	}
	if in.SSHKey != "" {
		creds.PrivateKey = []byte(in.SSHKey)
	}
	return creds
}

// Repair regenerates an enrollment token; the admin can use it to re-pair an agent
// whose state file was lost or that was reinstalled. Existing machine_tokens stay valid
// until the agent rotates them on next enroll/auto-register.
func (a *ServersAPI) Repair(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/repair")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	tok, exp, err := a.Tokens.IssueEnrollmentToken(r.Context(), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"enrollment_token": tok,
		"expires_at":       exp,
	})
}

type configReq struct {
	TelemetryIntervalSeconds int `json:"telemetry_interval_seconds"`
}

func (a *ServersAPI) Config(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/config")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	var in configReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if in.TelemetryIntervalSeconds < 5 || in.TelemetryIntervalSeconds > 3600 {
		writeError(w, 400, "telemetry_interval_seconds must be 5..3600")
		return
	}
	env, err := agentapi.Frame(agentapi.TypeConfigUpdate, agentapi.ConfigUpdate{
		TelemetryIntervalSeconds: in.TelemetryIntervalSeconds,
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	if err := a.Hub.Send(id, env); err != nil {
		writeError(w, 409, err.Error()) // 409 — agent offline
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
