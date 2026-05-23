package web

import (
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandler_PlaceholderWhenNoIndex(t *testing.T) {
	sub, _ := fs.Sub(distFS, "dist")
	if _, err := fs.ReadFile(sub, "index.html"); err == nil {
		t.Skip("dist/index.html is present — placeholder path is not exercised")
	}
	h := Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Frontend not built") {
		t.Errorf("expected placeholder, got %q", w.Body.String())
	}
}

func TestHandler_PlaceholderForAdminPath(t *testing.T) {
	sub, _ := fs.Sub(distFS, "dist")
	if _, err := fs.ReadFile(sub, "index.html"); err == nil {
		t.Skip("dist/index.html is present — placeholder path is not exercised")
	}
	h := Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/admin/login", nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "Frontend not built") {
		t.Error("expected placeholder for /admin/login when index.html absent")
	}
}

func TestHandler_AssetPathReturns404WhenAbsent(t *testing.T) {
	h := Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/assets/missing.js", nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Errorf("status=%d want 404", w.Code)
	}
}

func TestHandler_GzipWhenAccepted(t *testing.T) {
	sub, _ := fs.Sub(distFS, "dist")
	if _, err := fs.ReadFile(sub, "index.html"); err != nil {
		t.Skip("dist/index.html missing — run `make web` to exercise gzip path")
	}
	h := Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Accept-Encoding", "gzip")
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if !strings.Contains(w.Header().Get("Vary"), "Accept-Encoding") {
		t.Errorf("Vary header missing Accept-Encoding")
	}
	// Body should actually be a valid gzip stream.
	gr, err := gzip.NewReader(bytes.NewReader(w.Body.Bytes()))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer func() { _ = gr.Close() }()
	if _, err := io.ReadAll(gr); err != nil {
		t.Fatalf("decompress: %v", err)
	}
}

func TestHandler_NoGzipWhenClientDoesntAsk(t *testing.T) {
	sub, _ := fs.Sub(distFS, "dist")
	if _, err := fs.ReadFile(sub, "index.html"); err != nil {
		t.Skip("dist/index.html missing")
	}
	h := Handler()
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	// No Accept-Encoding → server must NOT silently compress.
	h.ServeHTTP(w, r)
	if got := w.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding = %q on non-gzip request, want empty", got)
	}
}

func TestHandler_LongTermCacheOnHashedAssets(t *testing.T) {
	// /assets/* paths get the immutable cache header; /index.html must
	// not (the SPA refresh boot relies on always-fresh HTML).
	//
	// Have to point at an asset that actually exists — http.FileServer's
	// 404 response handler scrubs all caller-set response headers in
	// favour of its own Content-Type/X-Content-Type-Options block. Pick
	// the freshest hashed file vite produced so the test is stable
	// against unrelated bundle re-builds.
	h := Handler()

	sub, _ := fs.Sub(distFS, "dist")
	assetPath := pickAnyAsset(t, sub)
	if assetPath == "" {
		t.Skip("no assets in embed FS — run `make web` first")
	}

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/"+assetPath, nil)
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d on %q", w.Code, assetPath)
	}
	if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
		t.Errorf("hashed asset Cache-Control = %q, want immutable", cc)
	}

	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	h.ServeHTTP(w, r)
	if cc := w.Header().Get("Cache-Control"); strings.Contains(cc, "immutable") {
		t.Errorf("index.html Cache-Control = %q, must not be immutable", cc)
	}
}

// pickAnyAsset walks the embedded dist FS for one file under assets/. Returns
// "" if there are none — caller should Skip.
func pickAnyAsset(t *testing.T, sub fs.FS) string {
	t.Helper()
	entries, err := fs.ReadDir(sub, "assets")
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if !e.IsDir() {
			return "assets/" + e.Name()
		}
	}
	return ""
}
