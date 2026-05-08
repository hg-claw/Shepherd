package filehandler

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type recordingSender struct {
	mu     sync.Mutex
	envs   []agentapi.Envelope
	chunks bytes.Buffer
}

func (r *recordingSender) SendControl(env agentapi.Envelope) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.envs = append(r.envs, env)
	return nil
}
func (r *recordingSender) SendBinary(_ string, _ byte, p []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.chunks.Write(p)
	return nil
}

func TestHandler_DownloadHappyPath(t *testing.T) {
	dir := realPath(t, t.TempDir())
	src := filepath.Join(dir, "in.bin")
	body := bytes.Repeat([]byte("a"), 700*1024)
	if err := os.WriteFile(src, body, 0644); err != nil {
		t.Fatal(err)
	}

	r := &recordingSender{}
	h := New(r)
	h.SetSandbox(&Sandbox{Enabled: true, Allowed: []string{dir}})
	h.HandleDownloadBegin(agentapi.FileDownloadBegin{Sid: "d1", Path: src})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		done := len(r.envs) > 0 && r.envs[len(r.envs)-1].Type == agentapi.TypeFileDownloadEnd
		r.mu.Unlock()
		if done {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.envs) < 2 {
		t.Fatalf("envs=%v", r.envs)
	}
	if r.envs[0].Type != agentapi.TypeFileDownloadMeta {
		t.Fatalf("first=%q", r.envs[0].Type)
	}
	var meta agentapi.FileDownloadMeta
	_ = json.Unmarshal(r.envs[0].P, &meta)
	if meta.Size != int64(len(body)) {
		t.Fatalf("meta size=%d", meta.Size)
	}
	if r.chunks.Len() != len(body) {
		t.Fatalf("chunks=%d body=%d", r.chunks.Len(), len(body))
	}
	if !bytes.Equal(r.chunks.Bytes(), body) {
		t.Fatal("body mismatch")
	}
}

func TestHandler_DownloadCancel(t *testing.T) {
	dir := realPath(t, t.TempDir())
	src := filepath.Join(dir, "big.bin")
	body := bytes.Repeat([]byte("a"), 5*1024*1024)
	_ = os.WriteFile(src, body, 0644)
	r := &recordingSender{}
	h := New(r)
	h.SetSandbox(&Sandbox{Enabled: true, Allowed: []string{dir}})
	h.HandleDownloadBegin(agentapi.FileDownloadBegin{Sid: "d2", Path: src})
	time.Sleep(5 * time.Millisecond)
	h.HandleCancel(agentapi.FileCancel{Sid: "d2", Reason: "test"})
	var dropped atomic.Bool
	go func() { time.Sleep(500 * time.Millisecond); dropped.Store(true) }()
	for !dropped.Load() {
		time.Sleep(20 * time.Millisecond)
	}
}
