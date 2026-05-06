package web

import (
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
