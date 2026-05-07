//go:build linux

package ptyrunner

import (
	"bytes"
	"context"
	"sync"
	"testing"
	"time"
)

type captureSender struct {
	mu     sync.Mutex
	output bytes.Buffer
	exit   chan int
}

func (c *captureSender) SendBinary(_ string, _ byte, p []byte) error {
	c.mu.Lock()
	c.output.Write(p)
	c.mu.Unlock()
	return nil
}
func (c *captureSender) SendExit(_ string, code int) {
	c.exit <- code
}

func TestRunner_EchoExits(t *testing.T) {
	cs := &captureSender{exit: make(chan int, 1)}
	r, err := Spawn(context.Background(), SpawnOpts{
		SID: "s", Kind: "script", User: "", Rows: 24, Cols: 80, Term: "xterm",
		Exec: "echo hello",
	}, cs)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close("test")
	select {
	case code := <-cs.exit:
		if code != 0 {
			t.Fatalf("exit code=%d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timeout waiting for exit")
	}
	cs.mu.Lock()
	defer cs.mu.Unlock()
	if !bytes.Contains(cs.output.Bytes(), []byte("hello")) {
		t.Fatalf("output=%q", cs.output.String())
	}
}

func TestRunner_RejectInvalidUser(t *testing.T) {
	cs := &captureSender{exit: make(chan int, 1)}
	_, err := Spawn(context.Background(), SpawnOpts{
		SID: "s", Kind: "script", User: "bad;user", Exec: "echo x",
	}, cs)
	if err == nil {
		t.Fatal("expected error for bad user")
	}
}
