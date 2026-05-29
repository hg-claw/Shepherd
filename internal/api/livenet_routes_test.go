package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/hg-claw/Shepherd/internal/livenet"
)

func TestLiveNetAttachWS_RequiresAdmin(t *testing.T) {
	a := &LiveNetAPI{Hub: livenet.NewHub()}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/admin/servers/1/net-live/ws", nil)
	a.AttachWS(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without admin, got %d", rec.Code)
	}
}
