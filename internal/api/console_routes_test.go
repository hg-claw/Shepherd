package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConsoleOpen_Unauth(t *testing.T) {
	a := &ConsoleAPI{}
	r := httptest.NewRequest("POST", "/api/admin/console/open", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	a.Open(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", w.Code)
	}
}
