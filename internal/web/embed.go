package web

import (
	"compress/gzip"
	"embed"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"sync"
)

//go:embed all:dist/*
var distFS embed.FS

// Handler returns an http.Handler that serves the SPA from internal/web/dist.
// Static assets (paths containing a dot) go through http.FileServer; everything
// else returns index.html so React Router can take over. If the frontend has
// not been built yet (only .gitkeep present), a small placeholder page is
// returned with instructions.
//
// Two perf-relevant behaviors:
//
//  1. Long-term caching for hashed assets. Anything under /assets/ has a
//     content-hashed filename (vite emits e.g. vendor-react-BDSGb2KX.js)
//     so it's safe to cache for a year + mark immutable. index.html stays
//     "no-cache" so the boot-time content negotiation still works.
//  2. Gzip on the fly. The bundle ships ~700 kB of JS in the main chunk
//     plus several ~300 kB vendor chunks. Without compression a slow
//     uplink delivers them at literal modem speed. The wrapper is a
//     tiny shim — clients that announce gzip get wrapped, others fall
//     through. (Brotli would shave another ~20% but adds a real dep;
//     gzip is in stdlib and gets us most of the win.)
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(sub))
	return gzipMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Static asset?
		if strings.Contains(strings.TrimPrefix(r.URL.Path, "/"), ".") {
			// /assets/<hash>.<ext> — content-addressed, safe to cache forever.
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
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
	}))
}

// gzipMiddleware wraps the response writer in a gzip stream when the client
// announces gzip support. Skips already-compressed content (images, fonts in
// woff2 which is pre-compressed) by inspecting the file extension.
func gzipMiddleware(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") || shouldSkipGzip(r.URL.Path) {
			h.ServeHTTP(w, r)
			return
		}
		gw := gzPool.Get().(*gzip.Writer)
		defer gzPool.Put(gw)
		gw.Reset(w)
		defer func() { _ = gw.Close() }()

		// Content-Length would lie if we sent it before compressing; the
		// http.FileServer sets it from the on-disk size. Strip it and let
		// chunked transfer take over.
		w.Header().Del("Content-Length")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		h.ServeHTTP(&gzipResponseWriter{ResponseWriter: w, gz: gw}, r)
	})
}

// shouldSkipGzip returns true for content that's already compressed and would
// only get larger if we ran gzip over it. The extension list covers what vite
// emits plus common static assets.
func shouldSkipGzip(p string) bool {
	switch ext := strings.ToLower(extOf(p)); ext {
	case ".woff2", ".woff", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".gz", ".br", ".zip":
		return true
	}
	return false
}

func extOf(p string) string {
	if i := strings.LastIndexByte(p, '.'); i >= 0 {
		return p[i:]
	}
	return ""
}

var gzPool = sync.Pool{
	New: func() any { return gzip.NewWriter(io.Discard) },
}

// gzipResponseWriter routes Write() through the gzip.Writer while leaving
// Header / WriteHeader unchanged. Implements http.Flusher so SSE-style
// responses don't buffer indefinitely (we don't currently stream anything
// through this handler but it's cheap to keep correct).
type gzipResponseWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzipResponseWriter) Write(p []byte) (int, error) { return g.gz.Write(p) }
func (g *gzipResponseWriter) Flush() {
	_ = g.gz.Flush()
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

const placeholderHTML = `<!doctype html><html><head><meta charset="utf-8"><title>Shepherd</title></head>
<body style="font-family:system-ui;margin:2rem;color:#333;background:#fafafa">
<h1>Shepherd</h1>
<p>Frontend not built yet. Run <code>make web</code> and restart the server.</p>
</body></html>`
