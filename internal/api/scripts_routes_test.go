package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestScriptsRun_Unauth(t *testing.T) {
	a := &ScriptsAPI{}
	r := httptest.NewRequest("POST", "/api/admin/scripts/1/run", strings.NewReader(`{}`))
	w := httptest.NewRecorder()
	a.Run(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", w.Code)
	}
}
