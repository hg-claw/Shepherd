package filehandler

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type captureSender struct {
	envs atomic.Value // []agentapi.Envelope
}

func (c *captureSender) SendControl(env agentapi.Envelope) error {
	cur, _ := c.envs.Load().([]agentapi.Envelope)
	c.envs.Store(append(cur, env))
	return nil
}
func (c *captureSender) SendBinary(string, byte, []byte) error { return nil }

func TestHandler_ListMkdirRm(t *testing.T) {
	dir := realPath(t, t.TempDir())
	enabled := true
	h := New(&captureSender{})
	h.SetSandbox(&Sandbox{Enabled: enabled, Allowed: []string{dir}})

	// mkdir
	h.HandleMkdir(agentapi.FileMkdir{Sid: "s1", Path: filepath.Join(dir, "sub"), Mode: 0755})
	if _, err := os.Stat(filepath.Join(dir, "sub")); err != nil {
		t.Fatalf("mkdir failed: %v", err)
	}
	// touch a file
	if err := os.WriteFile(filepath.Join(dir, "sub", "x.txt"), []byte("hi"), 0644); err != nil {
		t.Fatal(err)
	}
	// list
	cs := h.sender.(*captureSender)
	cs.envs.Store([]agentapi.Envelope{})
	h.HandleList(agentapi.FileList{Sid: "s2", Path: filepath.Join(dir, "sub")})
	envs, _ := cs.envs.Load().([]agentapi.Envelope)
	if len(envs) != 1 || envs[0].Type != agentapi.TypeFileListResult {
		t.Fatalf("envs=%v", envs)
	}
	var res agentapi.FileListResult
	_ = json.Unmarshal(envs[0].P, &res)
	if len(res.Entries) != 1 || res.Entries[0].Name != "x.txt" {
		t.Fatalf("entries=%v", res.Entries)
	}
	// rm recursive
	cs.envs.Store([]agentapi.Envelope{})
	h.HandleRm(agentapi.FileRm{Sid: "s3", Path: filepath.Join(dir, "sub"), Recursive: true})
	if _, err := os.Stat(filepath.Join(dir, "sub")); !os.IsNotExist(err) {
		t.Fatalf("rm did not remove: %v", err)
	}
}

func TestHandler_SandboxReject(t *testing.T) {
	dir := realPath(t, t.TempDir())
	cs := &captureSender{}
	h := New(cs)
	h.SetSandbox(&Sandbox{Enabled: true, Allowed: []string{dir}})
	h.HandleList(agentapi.FileList{Sid: "x", Path: "/etc/shadow"})
	envs, _ := cs.envs.Load().([]agentapi.Envelope)
	if len(envs) != 1 {
		t.Fatalf("envs=%v", envs)
	}
	var res agentapi.FileListResult
	_ = json.Unmarshal(envs[0].P, &res)
	if res.Error == "" {
		t.Fatalf("want error, got %+v", res)
	}
}
