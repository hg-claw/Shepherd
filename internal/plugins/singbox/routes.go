package singbox

import "github.com/hg-claw/Shepherd/internal/plugins"

// registerRoutes wires all sing-box HTTP routes onto the provided mux.
// Called from Plugin.RegisterRoutes.
// Additional routes (/versions, PATCH /servers/:id, /certificates) are wired in Task 13.
func registerRoutes(mux plugins.Mux, deps plugins.Deps) {
	mux.HandleFunc("POST /inbounds",        postInboundHandler(deps))
	mux.HandleFunc("GET /inbounds",         getInboundsHandler(deps))
	mux.HandleFunc("PATCH /inbounds/{id}",  patchInboundHandler(deps))
	mux.HandleFunc("DELETE /inbounds/{id}", deleteInboundHandler(deps))
}
