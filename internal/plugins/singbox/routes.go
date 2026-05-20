package singbox

import "github.com/hg-claw/Shepherd/internal/plugins"

// registerRoutes wires all sing-box HTTP routes onto the provided mux.
// Called from Plugin.RegisterRoutes.
func registerRoutes(mux plugins.Mux, deps plugins.Deps) {
	// Inbound CRUD.
	mux.HandleFunc("POST /inbounds",        postInboundHandler(deps))
	mux.HandleFunc("GET /inbounds",         getInboundsHandler(deps))
	mux.HandleFunc("PATCH /inbounds/{id}",  patchInboundHandler(deps))
	mux.HandleFunc("DELETE /inbounds/{id}", deleteInboundHandler(deps))

	// Certificate management.
	mux.HandleFunc("POST /certificates",           postCertHandler(deps))
	mux.HandleFunc("GET /certificates",            getCertsHandler(deps))
	mux.HandleFunc("DELETE /certificates/{id}",    deleteCertHandler(deps))
	mux.HandleFunc("POST /certificates/{id}/renew", postCertRenewHandler(deps))

	// Version management + server-level deploy.
	mux.HandleFunc("GET /versions",       getVersionsHandler(deps))
	mux.HandleFunc("PATCH /servers/{id}", patchSBServerVersionHandler(deps))
}
