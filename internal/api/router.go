package api

import (
	"net/http"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

type Router struct {
	Auth       *AuthAPI
	Servers    *ServersAPI
	Settings   *SettingsAPI
	Public     *PublicAPI
	Agent      *AgentAPI
	Console    *ConsoleAPI
	Scripts    *ScriptsAPI
	Files      *FilesAPI
	Audit      *AuditAPI
	Recordings *RecordingsAPI
	Web        http.Handler

	// Plugin APIs — optional; set via WithPlugins.
	Plugins      *PluginsAPI
	PluginEvents *PluginEventsAPI
	PluginLogs   *PluginLogsAPI

	requireAdmin func(http.Handler) http.Handler
}

func NewRouter(authAPI *AuthAPI, requireAdmin func(http.Handler) http.Handler,
	servers *ServersAPI, settings *SettingsAPI, public *PublicAPI, agent *AgentAPI,
	console *ConsoleAPI, scripts *ScriptsAPI, files *FilesAPI, audit *AuditAPI, recs *RecordingsAPI,
	web http.Handler) *Router {
	return &Router{
		Auth: authAPI, Servers: servers, Settings: settings, Public: public, Agent: agent,
		Console: console, Scripts: scripts, Files: files, Audit: audit, Recordings: recs,
		Web:          web,
		requireAdmin: requireAdmin,
	}
}

// WithPlugins attaches the plugin API handlers so Handler() registers plugin routes.
func (r *Router) WithPlugins(p *PluginsAPI, ev *PluginEventsAPI, logs *PluginLogsAPI) *Router {
	r.Plugins = p
	r.PluginEvents = ev
	r.PluginLogs = logs
	return r
}

func (r *Router) Handler() http.Handler {
	mux := http.NewServeMux()

	// health
	mux.HandleFunc("GET /healthz", r.Public.Healthz)
	mux.HandleFunc("GET /api/version", r.Public.Version)

	// public
	mux.HandleFunc("GET /api/public/servers", r.Public.Servers_ListPublic)
	mux.HandleFunc("GET /api/public/servers/{id}/telemetry", r.Public.Telemetry)
	mux.HandleFunc("GET /api/public/servers/{id}/netquality", r.Public.NetqualityHistoryHandler)
	mux.HandleFunc("GET /api/public/settings", r.Public.GetSettings)
	mux.HandleFunc("GET /api/agent/status", r.Public.AgentStatus)

	// auth (login/logout — no admin guard yet, login is the gate)
	mux.HandleFunc("POST /api/login", r.Auth.Login)
	mux.HandleFunc("POST /api/logout", r.Auth.Logout)

	// admin sub-mux (gated by requireAdmin)
	admin := http.NewServeMux()
	admin.HandleFunc("GET /api/admins/me", r.Auth.Me)

	admin.HandleFunc("GET /api/servers", r.Servers.List)
	admin.HandleFunc("POST /api/servers", r.Servers.Create)
	admin.HandleFunc("POST /api/servers/install", r.Servers.Install)
	admin.HandleFunc("POST /api/servers/{id}/reinstall", r.Servers.Reinstall)
	admin.HandleFunc("POST /api/servers/script", r.Servers.ScriptInstall)
	admin.HandleFunc("GET /api/servers/{id}", r.Servers.Get)
	admin.HandleFunc("PATCH /api/servers/{id}", r.Servers.Patch)
	admin.HandleFunc("DELETE /api/servers/{id}", r.Servers.Delete)
	admin.HandleFunc("GET /api/servers/{id}/telemetry", r.Servers.Telemetry)
	admin.HandleFunc("POST /api/servers/{id}/repair", r.Servers.Repair)
	admin.HandleFunc("POST /api/servers/{id}/install-command", r.Servers.InstallCommand)
	admin.HandleFunc("POST /api/servers/{id}/update-agent", r.Servers.UpdateAgent)
	admin.HandleFunc("POST /api/servers/update-agent", r.Servers.BatchUpdateAgent)
	admin.HandleFunc("POST /api/servers/{id}/config", r.Servers.Config)
	admin.HandleFunc("GET /api/servers/{id}/ip-candidates", r.Servers.IPCandidates)

	admin.HandleFunc("GET /api/settings", r.Settings.GetAll)
	admin.HandleFunc("PATCH /api/settings", r.Settings.Patch)

	admin.HandleFunc("POST /api/admin/console/open", r.Console.Open)
	admin.HandleFunc("GET /api/admin/console/ws", r.Console.AttachWS)

	admin.HandleFunc("GET /api/admin/scripts", r.Scripts.List)
	admin.HandleFunc("POST /api/admin/scripts", r.Scripts.Create)
	admin.HandleFunc("PATCH /api/admin/scripts/{id}", r.Scripts.Update)
	admin.HandleFunc("DELETE /api/admin/scripts/{id}", r.Scripts.Delete)
	admin.HandleFunc("POST /api/admin/scripts/{id}/run", r.Scripts.Run)
	admin.HandleFunc("GET /api/admin/script-runs", r.Scripts.RunsList)
	admin.HandleFunc("GET /api/admin/script-runs/{id}", r.Scripts.RunDetail)

	admin.HandleFunc("GET /api/admin/files", r.Files.List)
	admin.HandleFunc("POST /api/admin/files/stat", r.Files.Stat)
	admin.HandleFunc("POST /api/admin/files/mkdir", r.Files.Mkdir)
	admin.HandleFunc("POST /api/admin/files/rename", r.Files.Rename)
	admin.HandleFunc("POST /api/admin/files/rm", r.Files.Rm)
	admin.HandleFunc("GET /api/admin/files/preview", r.Files.Preview)
	admin.HandleFunc("GET /api/admin/files/download", r.Files.Download)
	admin.HandleFunc("POST /api/admin/files/upload", r.Files.Upload)

	admin.HandleFunc("GET /api/admin/audit", r.Audit.List)
	admin.HandleFunc("GET /api/admin/recordings/{id}/cast", r.Recordings.Cast)

	// Plugin routes — only registered when WithPlugins has been called.
	if r.Plugins != nil {
		admin.HandleFunc("GET /api/admin/plugins", r.Plugins.List)
		admin.HandleFunc("POST /api/admin/plugins/{id}/enable", r.Plugins.Enable)
		admin.HandleFunc("POST /api/admin/plugins/{id}/disable", r.Plugins.Disable)
		admin.HandleFunc("GET /api/admin/plugins/{id}/config", r.Plugins.GetConfig)
		admin.HandleFunc("PUT /api/admin/plugins/{id}/config", r.Plugins.PutConfig)
		admin.HandleFunc("GET /api/admin/plugins/{id}/hosts", r.Plugins.ListHosts)
		admin.HandleFunc("POST /api/admin/plugins/{id}/hosts", r.Plugins.PostHost)
		admin.HandleFunc("GET /api/admin/plugins/{id}/hosts/{server_id}", r.Plugins.GetHost)
		admin.HandleFunc("DELETE /api/admin/plugins/{id}/hosts/{server_id}", r.Plugins.DeleteHost)
		admin.HandleFunc("POST /api/admin/plugins/{id}/hosts/{server_id}/start", r.Plugins.PostHostLifecycle)
		admin.HandleFunc("POST /api/admin/plugins/{id}/hosts/{server_id}/stop", r.Plugins.PostHostLifecycle)
		admin.HandleFunc("POST /api/admin/plugins/{id}/hosts/{server_id}/restart", r.Plugins.PostHostLifecycle)
		admin.HandleFunc("GET /api/admin/plugins/{id}/hosts/{server_id}/refresh-status", r.Plugins.GetHostRefreshStatus)

		// Mount per-plugin routes, gated by enabled flag.
		for _, p := range plugins.All() {
			prefix := "/api/admin/plugins/" + p.Meta().ID
			g := &GatedMux{Parent: admin, Prefix: prefix, Store: r.Plugins.Store, ID: p.Meta().ID}
			p.RegisterRoutes(g, r.Plugins.Deps)
		}
	}
	if r.PluginEvents != nil {
		admin.HandleFunc("GET /api/admin/plugins/{id}/events", r.PluginEvents.List)
	}
	if r.PluginLogs != nil {
		admin.HandleFunc("GET /api/admin/plugins/{id}/hosts/{server_id}/logs", r.PluginLogs.AttachWS)
	}

	gated := r.requireAdmin(admin)

	// Catch-all for /api/ that defers to the gated admin mux for everything except
	// public + login/logout (already handled above).
	mux.HandleFunc("/api/", func(w http.ResponseWriter, req *http.Request) {
		p := req.URL.Path
		if strings.HasPrefix(p, "/api/public/") || p == "/api/login" || p == "/api/logout" {
			http.NotFound(w, req)
			return
		}
		gated.ServeHTTP(w, req)
	})

	// agent
	mux.HandleFunc("POST /agent/enroll", r.Agent.Enroll)
	mux.HandleFunc("POST /agent/auto-register", r.Agent.AutoRegister)
	mux.HandleFunc("GET /agent/ws", r.Agent.WS)

	// SPA static + fallback. /api/ catchall above already swallows /api/*; the
	// /agent/* exact patterns swallow agent paths. Anything else falls through here.
	if r.Web != nil {
		mux.Handle("/", r.Web)
	}

	return mux
}
