package api

import (
	"net/http"
	"strings"
)

type Router struct {
	Auth     *AuthAPI
	Servers  *ServersAPI
	Settings *SettingsAPI
	Public   *PublicAPI
	Agent    *AgentAPI

	requireAdmin func(http.Handler) http.Handler
}

func NewRouter(authAPI *AuthAPI, requireAdmin func(http.Handler) http.Handler,
	servers *ServersAPI, settings *SettingsAPI, public *PublicAPI, agent *AgentAPI) *Router {
	return &Router{
		Auth: authAPI, Servers: servers, Settings: settings, Public: public, Agent: agent,
		requireAdmin: requireAdmin,
	}
}

func (r *Router) Handler() http.Handler {
	mux := http.NewServeMux()

	// public
	mux.HandleFunc("GET /api/public/servers", r.Public.Servers_ListPublic)
	mux.HandleFunc("GET /api/public/servers/{id}/telemetry", r.Public.Telemetry)
	mux.HandleFunc("GET /api/public/settings", r.Public.GetSettings)

	// auth (login/logout — no admin guard yet, login is the gate)
	mux.HandleFunc("POST /api/login", r.Auth.Login)
	mux.HandleFunc("POST /api/logout", r.Auth.Logout)

	// admin sub-mux (gated by requireAdmin)
	admin := http.NewServeMux()
	admin.HandleFunc("GET /api/admins/me", r.Auth.Me)

	admin.HandleFunc("GET /api/servers", r.Servers.List)
	admin.HandleFunc("POST /api/servers", r.Servers.Create)
	admin.HandleFunc("POST /api/servers/install", r.Servers.Install)
	admin.HandleFunc("GET /api/servers/{id}", r.Servers.Get)
	admin.HandleFunc("PATCH /api/servers/{id}", r.Servers.Patch)
	admin.HandleFunc("DELETE /api/servers/{id}", r.Servers.Delete)
	admin.HandleFunc("GET /api/servers/{id}/telemetry", r.Servers.Telemetry)
	admin.HandleFunc("POST /api/servers/{id}/repair", r.Servers.Repair)
	admin.HandleFunc("POST /api/servers/{id}/config", r.Servers.Config)

	admin.HandleFunc("GET /api/settings", r.Settings.GetAll)
	admin.HandleFunc("PATCH /api/settings", r.Settings.Patch)

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

	return mux
}
