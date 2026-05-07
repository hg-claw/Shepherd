//go:build linux

package filehandler

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func TestHandler_UploadHappyPath(t *testing.T) {
	dir := t.TempDir()
	cs := &captureSender{}
	h := New(cs)
	h.SetSandbox(&Sandbox{Enabled: true, Allowed: []string{dir}})

	target := filepath.Join(dir, "out.bin")
	body := []byte("hello world!")
	sum := sha256.Sum256(body)
	hexSum := hex.EncodeToString(sum[:])

	h.HandleUploadBegin(agentapi.FileUploadBegin{Sid: "u1", Path: target, Size: int64(len(body)), Mode: 0644})
	h.HandleUploadChunk("u1", body)
	h.HandleUploadEnd(agentapi.FileUploadEnd{Sid: "u1", TotalBytes: int64(len(body)), SHA256: hexSum})

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read out: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("body=%q", got)
	}

	envs, _ := cs.envs.Load().([]agentapi.Envelope)
	if len(envs) == 0 {
		t.Fatal("no envelopes")
	}
	last := envs[len(envs)-1]
	if last.Type != agentapi.TypeFileUploadAck {
		t.Fatalf("last type=%q", last.Type)
	}
	var ack agentapi.FileUploadAck
	_ = json.Unmarshal(last.P, &ack)
	if !ack.OK {
		t.Fatalf("ack=%+v", ack)
	}
}

func TestHandler_UploadShaMismatch(t *testing.T) {
	dir := t.TempDir()
	cs := &captureSender{}
	h := New(cs)
	h.SetSandbox(&Sandbox{Enabled: true, Allowed: []string{dir}})

	target := filepath.Join(dir, "out.bin")
	h.HandleUploadBegin(agentapi.FileUploadBegin{Sid: "u2", Path: target, Size: 5, Mode: 0644})
	h.HandleUploadChunk("u2", []byte("hello"))
	h.HandleUploadEnd(agentapi.FileUploadEnd{Sid: "u2", TotalBytes: 5, SHA256: "deadbeef"})

	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatalf("target should not exist on sha mismatch: %v", err)
	}
	envs, _ := cs.envs.Load().([]agentapi.Envelope)
	last := envs[len(envs)-1]
	var ack agentapi.FileUploadAck
	_ = json.Unmarshal(last.P, &ack)
	if ack.OK {
		t.Fatalf("expected fail, ack=%+v", ack)
	}
}
