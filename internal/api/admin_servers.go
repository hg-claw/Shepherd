package api

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/installer"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
)

// hostExecer is the minimal subset of plugins.HostExec needed by UpdateAgent.
type hostExecer interface {
	RunCmd(ctx context.Context, serverID int64, name string, args ...string) (stdout, stderr []byte, exitCode int, err error)
}

type ServersAPI struct {
	Servers        *serversvc.Service
	Settings       *serversvc.SettingsStore
	Query          *telemetrysvc.Query
	Hub            *agentsvc.Hub
	InstallManager *serversvc.InstallManager
	Tokens         *agentsvc.Service // for repair; also provides ListIPCandidates
	HostExec       hostExecer        // for UpdateAgent / BatchUpdateAgent
	// BuildVersion and PublicURL are used by ScriptInstall to embed the
	// pinned script URL and server address in the returned curl|bash command.
	BuildVersion string
	PublicURL    string
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
		Latest    *telemetrysvc.Point `json:"latest"`
		Connected bool                `json:"connected"`
	}
	out := make([]wrapped, 0, len(servers))
	for _, s := range servers {
		pt, _ := a.Query.Latest(r.Context(), s.ID) // nil if no telemetry yet — fine
		out = append(out, wrapped{Server: s, Latest: pt, Connected: a.hubIsOnline(s.ID)})
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

// hubIsOnline returns Hub.IsOnline(id) when the hub is wired, false otherwise.
// Hub may be nil in unit tests that exercise only the DB layer.
func (a *ServersAPI) hubIsOnline(id int64) bool {
	if a.Hub == nil {
		return false
	}
	return a.Hub.IsOnline(id)
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
	writeJSON(w, 200, struct {
		*serversvc.Server
		Connected bool `json:"connected"`
	}{Server: srv, Connected: a.hubIsOnline(id)})
}

type patchReq struct {
	Name         *string `json:"name"`
	PublicAlias  *string `json:"public_alias"`
	PublicGroup  *string `json:"public_group"`
	CountryCode  *string `json:"country_code"`
	ShowOnPublic *bool   `json:"show_on_public"`
	SSHHost      *string `json:"ssh_host"`
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
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic, SSHHost: in.SSHHost,
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

// IPCandidates returns the known IP candidates for a server.
// GET /api/servers/{id}/ip-candidates
func (a *ServersAPI) IPCandidates(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, 400, "bad id")
		return
	}
	rows, err := a.Tokens.ListIPCandidates(r.Context(), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, rows)
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

type scriptInstallReq struct {
	Name         string `json:"name"`
	PublicAlias  string `json:"public_alias"`
	PublicGroup  string `json:"public_group"`
	CountryCode  string `json:"country_code"`
	ShowOnPublic bool   `json:"show_on_public"`
	// CN routes both the script URL and the install-time release-asset
	// downloads through https://gh-proxy.com/. Set when the target host
	// is in mainland China and can't reach github.com directly.
	CN           bool   `json:"cn"`
}

// ScriptInstall creates a server row with no SSH credentials (the agent
// will fill in connection metadata via auto-register on first WS connect)
// and returns the one-shot curl|bash install command.
func (a *ServersAPI) ScriptInstall(w http.ResponseWriter, r *http.Request) {
	var in scriptInstallReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, 400, "name required")
		return
	}
	srv, err := a.Servers.Create(r.Context(), serversvc.CreateInput{
		Name:         in.Name,
		PublicAlias:  in.PublicAlias,
		PublicGroup:  in.PublicGroup,
		CountryCode:  in.CountryCode,
		ShowOnPublic: in.ShowOnPublic,
		// No SSH fields — script flow doesn't need them.
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	tok, exp, err := a.Tokens.IssueEnrollmentToken(r.Context(), srv.ID)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, map[string]any{
		"server_id":  srv.ID,
		"token":      tok,
		"expires_at": exp,
		"command":    buildInstallCommand(a.BuildVersion, a.PublicURL, tok, in.CN),
	})
}

// InstallCommand returns a fresh install command for an existing server,
// for re-running install on a new target machine or upgrading the agent
// to the current server's release. Mints a new enrollment token (60min
// TTL, single-use); does not invalidate previous tokens.
func (a *ServersAPI) InstallCommand(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID2(r, "/api/servers/", "/install-command")
	if !ok {
		writeError(w, 400, "bad path")
		return
	}
	if _, err := a.Servers.Get(r.Context(), id); err != nil {
		writeError(w, 404, "server not found")
		return
	}
	tok, exp, err := a.Tokens.IssueEnrollmentToken(r.Context(), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	cn := r.URL.Query().Get("cn") == "1" || r.URL.Query().Get("cn") == "true"
	writeJSON(w, 200, map[string]any{
		"server_id":  id,
		"token":      tok,
		"expires_at": exp,
		"command":    buildInstallCommand(a.BuildVersion, a.PublicURL, tok, cn),
	})
}

// UpdateAgent triggers an in-place agent upgrade on the target server by
// dispatching the install script via the agent's existing RunCmd capability.
// The script restarts the systemd unit mid-run, which kills the WebSocket
// connection — we therefore fire-and-forget the command in a goroutine and
// return 202 immediately.
//
// POST /api/servers/{id}/update-agent
func (a *ServersAPI) UpdateAgent(w http.ResponseWriter, r *http.Request) {
	idStr := r.PathValue("id")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, 400, "bad id")
		return
	}
	if _, err := a.Servers.Get(r.Context(), id); err != nil {
		if errors.Is(err, serversvc.ErrNotFound) {
			writeError(w, 404, "server not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	if !a.Hub.IsOnline(id) {
		writeError(w, 409, "agent offline")
		return
	}
	tok, exp, err := a.Tokens.IssueEnrollmentToken(r.Context(), id)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	// Optional ?cn=1 to route the update through the gh-proxy mirror.
	// Doesn't persist anywhere — each update call passes its own flag.
	cn := r.URL.Query().Get("cn") == "1" || r.URL.Query().Get("cn") == "true"
	cmd := buildInstallCommand(a.BuildVersion, a.PublicURL, tok, cn)
	// Fire-and-forget: the install script restarts the agent service which
	// kills the WS connection. Reading the result would block forever.
	go func() {
		ctx := context.Background()
		_, _, _, _ = a.HostExec.RunCmd(ctx, id, "sh", "-c", cmd)
	}()
	writeJSON(w, 202, map[string]any{
		"ok":             true,
		"target_version": a.BuildVersion,
		"expires_at":     exp,
	})
}

type batchUpdateReq struct {
	ServerIDs []int64 `json:"server_ids"`
	// CN routes every spawned install through the gh-proxy mirror.
	// Pass once per batch; applies to every server in the request.
	CN        bool    `json:"cn"`
}

type batchUpdateResult struct {
	ServerID int64  `json:"server_id"`
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
}

// BatchUpdateAgent triggers in-place agent upgrades on multiple servers in
// parallel (up to 20 concurrent goroutines).
//
// POST /api/servers/update-agent
func (a *ServersAPI) BatchUpdateAgent(w http.ResponseWriter, r *http.Request) {
	var in batchUpdateReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if len(in.ServerIDs) == 0 {
		writeError(w, 400, "server_ids required")
		return
	}

	const maxConcurrent = 20
	sem := make(chan struct{}, maxConcurrent)

	results := make([]batchUpdateResult, len(in.ServerIDs))
	var wg sync.WaitGroup
	for i, sID := range in.ServerIDs {
		wg.Add(1)
		go func(idx int, serverID int64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			res := batchUpdateResult{ServerID: serverID, OK: false}
			defer func() { results[idx] = res }()

			if _, err := a.Servers.Get(r.Context(), serverID); err != nil {
				if errors.Is(err, serversvc.ErrNotFound) {
					res.Error = "not found"
				} else {
					res.Error = err.Error()
				}
				return
			}
			if !a.Hub.IsOnline(serverID) {
				res.Error = "agent offline"
				return
			}
			tok, _, err := a.Tokens.IssueEnrollmentToken(r.Context(), serverID)
			if err != nil {
				res.Error = err.Error()
				return
			}
			cmd := buildInstallCommand(a.BuildVersion, a.PublicURL, tok, in.CN)
			go func() {
				ctx := context.Background()
				_, _, _, _ = a.HostExec.RunCmd(ctx, serverID, "sh", "-c", cmd)
			}()
			res.OK = true
		}(i, sID)
	}
	wg.Wait()
	writeJSON(w, 200, map[string]any{"results": results})
}

// buildInstallCommand renders the install / upgrade command dispatched to
// a target host. The script URL AND the --version flag are both pinned to
// the running server's BuildVersion so script + binary + server stay in
// lockstep. For dev builds we point the script URL at `main` (raw URLs
// have no `latest` symlink) and pass --version=main so the script's
// release_tag helper picks `main` over the hardcoded BUILD_TAG fallback
// baked into the .sh.
//
// Pre-fix #1 (older): the script always re-installed v0.5.0 regardless
// of server version because the .sh's BUILD_TAG was a hardcoded constant
// and we passed no --version override; upgrades were silently a no-op.
//
// Pre-fix #2 (v0.7.8): the dispatched command was a bare `curl | bash`
// child of the agent's cgroup. When install-agent.sh hit
// `systemctl stop shepherd-agent`, systemd's default cgroup-wide kill
// took down the install script mid-binary-swap, then `Restart=always`
// brought the OLD binary back. Operators saw "agent restarts to same
// version, no error". Wrap with systemd-run so the install runs as its
// own transient unit in a brand-new cgroup, immune to shepherd-agent's
// teardown. The `setsid` fallback covers hosts without systemd-run
// (rare — sysvinit, busybox) but isn't as cgroup-robust.
func buildInstallCommand(buildVersion, publicURL, token string, cn bool) string {
	tag := buildVersion
	if tag == "" || tag == "dev" {
		tag = "main"
	}
	// The script URL itself is github-hosted, so the cn-mirror has to
	// be applied here too — otherwise the operator can't even download
	// the installer from a mainland host. The installer's --cn flag
	// then propagates the prefix to subsequent asset downloads.
	scriptURL := "https://raw.githubusercontent.com/hg-claw/Shepherd/" + tag + "/scripts/install-agent.sh"
	if cn {
		scriptURL = "https://gh-proxy.com/" + scriptURL
	}
	inner := "curl -fsSL " + scriptURL +
		" | sudo bash -s -- --token " + token +
		" --server " + publicURL +
		" --version " + tag
	if cn {
		inner += " --cn"
	}
	// Single-quote wrapping the inner command. Token / URL / version
	// never contain single quotes in practice (token is base64-ish, URL
	// from server config, version is a semver tag), and we control all
	// three at this layer.
	return "if command -v systemd-run >/dev/null 2>&1; then" +
		" systemd-run --quiet --collect --unit=shepherd-agent-update sh -c '" + inner + "';" +
		" else" +
		" (setsid sh -c '" + inner + "' </dev/null >/var/log/shepherd-agent-update.log 2>&1 &);" +
		" fi"
}
