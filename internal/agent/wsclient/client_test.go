package wsclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agent/state"
	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentconfig"
)

func TestAcquireToken_AutoRegisterFlow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/auto-register" {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		var req agentapi.AutoRegisterRequest
		_ = json.Unmarshal(body, &req)
		if req.AutoRecoverKey != "k" || req.Fingerprint != "fp" {
			http.Error(w, "bad", 400)
			return
		}
		_ = json.NewEncoder(w).Encode(agentapi.EnrollResponse{MachineToken: "tok", ServerID: 7})
	}))
	defer srv.Close()

	statePath := filepath.Join(t.TempDir(), "s.json")
	st := &state.Store{Path: statePath}
	_ = st.Save(&state.State{Fingerprint: "fp"})
	c := New(agentconfig.Config{ServerURL: srv.URL, AutoRecoverKey: "k", AgentVersion: "v0"}, st, nil, "h")

	cur, _ := st.Load()
	if err := c.acquireToken(context.Background(), cur); err != nil {
		t.Fatal(err)
	}
	got, _ := st.Load()
	if got.MachineToken != "tok" {
		t.Fatalf("token=%q", got.MachineToken)
	}
}

func TestPostJSON_PermanentOn401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", 401)
	}))
	defer srv.Close()
	c := New(agentconfig.Config{ServerURL: srv.URL}, &state.Store{Path: filepath.Join(t.TempDir(), "s.json")}, nil, "h")
	var out struct{}
	if err := c.postJSON(context.Background(), "/agent/enroll", struct{}{}, &out); err == nil || err != ErrPermanent {
		t.Fatalf("err=%v want ErrPermanent", err)
	}
}
