package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed all:dist/*
var distFS embed.FS

// Handler returns an http.Handler that serves the SPA from internal/web/dist.
// Static assets (paths containing a dot) go through http.FileServer; everything
// else returns index.html so React Router can take over. If the frontend has
// not been built yet (only .gitkeep present), a small placeholder page is
// returned with instructions.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Static asset?
		if strings.Contains(strings.TrimPrefix(r.URL.Path, "/"), ".") {
			fileServer.ServeHTTP(w, r)
			return
		}
		// SPA fallback.
		b, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = w.Write([]byte(placeholderHTML))
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(b)
	})
}

const placeholderHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Shepherd</title></head>
<body style="font-family:system-ui;margin:2rem;color:#333;background:#fafafa">
<h1>Shepherd</h1>
<p>Frontend not built yet. Run <code>make web</code> and restart the server.</p>
</body></html>`
