package filesvc

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

type sentEnv struct {
	serverID int64
	env      agentapi.Envelope
}

type stubHub struct {
	sent chan sentEnv
	reg  *sessionmux.Registry
}

func (h *stubHub) Send(serverID int64, env agentapi.Envelope) error {
	h.sent <- sentEnv{serverID, env}
	return nil
}
func (h *stubHub) SendBinary(_ int64, _ string, _ byte, _ []byte) error { return nil }

func TestList_Bridges(t *testing.T) {
	reg := sessionmux.New()
	hub := &stubHub{sent: make(chan sentEnv, 1), reg: reg}
	svc := &Service{Hub: hub, Reg: reg}
	go func() {
		s := <-hub.sent
		var req agentapi.FileList
		_ = s.env.Decode(&req)
		ent := []agentapi.FileEntry{{Name: "x.txt", Size: 5, IsDir: false}}
		raw, _ := json.Marshal(agentapi.FileListResult{Sid: req.Sid, Entries: ent})
		reg.Deliver(agentapi.Envelope{Sid: req.Sid, Type: agentapi.TypeFileListResult, P: raw})
	}()
	out, err := svc.List(context.Background(), 7, "/tmp", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Name != "x.txt" {
		t.Fatalf("entries=%v", out)
	}
}
