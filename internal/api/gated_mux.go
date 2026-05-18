package api

import (
	"net/http"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// GatedMux is a plugins.Mux adapter that mounts plugin routes under a prefix
// on a parent ServeMux, with a middleware that returns 404 when the plugin
// row is disabled. The router never needs to be rebuilt on enable/disable.
type GatedMux struct {
	Parent *http.ServeMux
	Prefix string        // e.g. "/api/admin/plugins/xray"
	Store  *plugins.Store
	ID     string // plugin ID for enabled lookups
}

func (g *GatedMux) HandleFunc(pattern string, h func(http.ResponseWriter, *http.Request)) {
	// Pattern from plugins is like "GET /versions" — split method, prefix the path.
	method, path, ok := strings.Cut(pattern, " ")
	if !ok {
		method, path = "", pattern
	}
	full := strings.TrimSpace(method + " " + g.Prefix + path)
	g.Parent.HandleFunc(full, func(w http.ResponseWriter, r *http.Request) {
		row, _ := g.Store.Get(r.Context(), g.ID)
		if !row.Enabled {
			http.Error(w, "plugin disabled", 404)
			return
		}
		h(w, r)
	})
}

func (g *GatedMux) Handle(pattern string, h http.Handler) {
	g.HandleFunc(pattern, h.ServeHTTP)
}
