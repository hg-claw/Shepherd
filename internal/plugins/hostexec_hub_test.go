package plugins

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/filesvc"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

// offlineHub simulates a hub where the agent is not connected.
type offlineHub struct{}

func (offlineHub) Send(_ int64, _ agentapi.Envelope) error { return agentsvc.ErrAgentOffline }
func (offlineHub) SendBinary(_ int64, _ string, _ byte, _ []byte) error {
	return agentsvc.ErrAgentOffline
}

// TestHubHostExec_PushFile_NoAgent verifies that PushFile returns an error
// (not a panic) when the agent for the given server is offline.
func TestHubHostExec_PushFile_NoAgent(t *testing.T) {
	reg := sessionmux.New()
	hub := offlineHub{}
	exec := &HubHostExec{
		Hub:   hub,
		Files: &filesvc.Service{Hub: hub, Reg: reg},
		Reg:   reg,
	}

	content := []byte("hello")
	err := exec.PushFile(context.Background(), 42, "/tmp/test.bin", 0755, content)
	if err == nil {
		t.Fatal("expected error for offline agent, got nil")
	}
	if !errors.Is(err, agentsvc.ErrAgentOffline) {
		t.Fatalf("expected ErrAgentOffline, got: %v", err)
	}
}

// TestHubHostExec_RunCmd_NoAgent verifies that RunCmd returns an error
// (not a panic) when the agent for the given server is offline.
func TestHubHostExec_RunCmd_NoAgent(t *testing.T) {
	reg := sessionmux.New()
	hub := offlineHub{}
	exec := &HubHostExec{
		Hub:   hub,
		Files: &filesvc.Service{Hub: hub, Reg: reg},
		Reg:   reg,
	}

	stdout, stderr, code, err := exec.RunCmd(context.Background(), 42, "echo", "hello")
	if err == nil {
		t.Fatal("expected error for offline agent, got nil")
	}
	if !errors.Is(err, agentsvc.ErrAgentOffline) {
		t.Fatalf("expected ErrAgentOffline, got: %v", err)
	}
	if stdout != nil || stderr != nil || code != 0 {
		t.Fatalf("expected zero values on error, got stdout=%v stderr=%v code=%d", stdout, stderr, code)
	}
}

// TestHubHostExec_RunCmd_CollectsOutput verifies that output from KindPTYOut
// frames is collected and returned, and that pty.exit delivers the exit code.
// This uses a fake hub that simulates a well-behaved agent.
func TestHubHostExec_RunCmd_CollectsOutput(t *testing.T) {
	reg := sessionmux.New()
	fakeHub := &echoHub{reg: reg, output: []byte("hello\n"), exitCode: 0}
	exec := &HubHostExec{
		Hub:   fakeHub,
		Files: &filesvc.Service{Hub: fakeHub, Reg: reg},
		Reg:   reg,
	}

	stdout, stderr, code, err := exec.RunCmd(context.Background(), 1, "echo", "hello")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !bytes.Equal(stdout, []byte("hello\n")) {
		t.Fatalf("stdout=%q want %q", stdout, "hello\n")
	}
	if stderr != nil {
		t.Fatalf("stderr=%v want nil", stderr)
	}
	if code != 0 {
		t.Fatalf("code=%d want 0", code)
	}
}

// TestHubHostExec_StreamCmd_NoAgent verifies that StreamCmd returns an error
// (not a panic) when the agent for the given server is offline.
func TestHubHostExec_StreamCmd_NoAgent(t *testing.T) {
	reg := sessionmux.New()
	hub := offlineHub{}
	exec := &HubHostExec{
		Hub:   hub,
		Files: &filesvc.Service{Hub: hub, Reg: reg},
		Reg:   reg,
	}

	err := exec.StreamCmd(context.Background(), 42, "journalctl", []string{"-f"}, func(string) {})
	if err == nil {
		t.Fatal("expected error for offline agent, got nil")
	}
	if !errors.Is(err, agentsvc.ErrAgentOffline) {
		t.Fatalf("expected ErrAgentOffline, got: %v", err)
	}
}

// TestShellJoin verifies shell quoting of name + args.
func TestShellJoin(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"echo", []string{"hello"}, "'echo' 'hello'"},
		{"sh", []string{"-c", "echo it's fine"}, `'sh' '-c' 'echo it'\''s fine'`},
		{"/usr/bin/cmd", nil, "'/usr/bin/cmd'"},
	}
	for _, tc := range cases {
		got := shellJoin(tc.name, tc.args)
		if got != tc.want {
			t.Errorf("shellJoin(%q, %v) = %q, want %q", tc.name, tc.args, got, tc.want)
		}
	}
}

// echoHub is a fake hub that, on receiving pty.open, immediately delivers
// the configured output bytes and then a pty.exit envelope via the registry.
type echoHub struct {
	reg      *sessionmux.Registry
	output   []byte
	exitCode int
}

func (h *echoHub) Send(_ int64, env agentapi.Envelope) error {
	if env.Type != agentapi.TypePTYOpen {
		return nil
	}
	var open agentapi.PTYOpen
	_ = env.Decode(&open)
	sid := open.Sid

	// Deliver output synchronously (the test goroutine hasn't blocked yet,
	// but the channel is buffered so this is safe).
	if len(h.output) > 0 {
		h.reg.DeliverBinary(sid, agentapi.KindPTYOut, h.output)
	}
	exitEnv, _ := agentapi.FrameSid(agentapi.TypePTYExit, sid, agentapi.PTYExit{Sid: sid, Code: h.exitCode})
	h.reg.Deliver(exitEnv)
	return nil
}

func (h *echoHub) SendBinary(_ int64, _ string, _ byte, _ []byte) error { return nil }
