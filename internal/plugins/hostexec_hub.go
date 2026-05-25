package plugins

import (
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/filesvc"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

// hubExecHub is the minimal subset of agentsvc.Hub that HubHostExec needs.
// Matches the Hub interfaces already defined in filesvc and ptysvc.
type hubExecHub interface {
	Send(serverID int64, env agentapi.Envelope) error
	SendBinary(serverID int64, sid string, kind byte, payload []byte) error
}

// HubHostExec implements plugins.HostExec by routing through the project's
// existing file-upload and PTY-exec infrastructure (filesvc + sessionmux).
//
// PushFile delegates to filesvc.Service.Upload which handles chunking for
// large files (e.g. 30 MB Xray binary) automatically.
//
// RunCmd and StreamCmd open a lightweight one-shot PTY session directly via
// the hub — no DB row is written because plugin exec is system-initiated
// (no admin context). The PTY kind "script" with an Exec field causes the
// agent to run the command and exit when it finishes.
//
// PTY does not separate stdout/stderr — both are merged into the binary
// KindPTYOut frames. RunCmd therefore always returns a nil stderr slice.
type HubHostExec struct {
	Hub  hubExecHub
	Files *filesvc.Service
	Reg  *sessionmux.Registry
}

// PushFile pushes content to path on the given host via the file-upload
// protocol. mode is a Unix permission bitmask (e.g. 0755).
func (h *HubHostExec) PushFile(ctx context.Context, serverID int64, path string, mode uint32, content []byte) error {
	sum := sha256.Sum256(content)
	sha256hex := fmt.Sprintf("%x", sum[:])
	reader := bytes.NewReader(content)
	return h.Files.Upload(ctx, serverID, path, mode, int64(len(content)), sha256hex, reader)
}

// FetchURL asks the agent at serverID to download spec.URL directly and
// install it at spec.Path. The WS link only carries the spec frame and
// the agent's ack; the binary bytes never go through Shepherd's hub.
func (h *HubHostExec) FetchURL(ctx context.Context, serverID int64, spec agentapi.FileFetch) error {
	return h.Files.Fetch(ctx, serverID, spec)
}

// RunCmd runs name with args on serverID, collects all PTY output, and waits
// for the process to exit. It returns stdout (merged with stderr — PTY
// limitation), an empty stderr slice, the process exit code, and any
// transport error.
//
// A 60-second hard deadline is applied unless ctx already has a shorter one.
func (h *HubHostExec) RunCmd(ctx context.Context, serverID int64, name string, args ...string) (stdout, stderr []byte, exitCode int, err error) {
	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	var buf bytes.Buffer
	var mu sync.Mutex
	var code int
	exitCh := make(chan int, 1)

	sess := &oneshotSession{
		onOutput: func(p []byte) {
			mu.Lock()
			buf.Write(p)
			mu.Unlock()
		},
		onExit: func(c int) {
			exitCh <- c
		},
	}

	sid, err := h.openOneShotPTY(runCtx, serverID, name, args, sess)
	if err != nil {
		return nil, nil, 0, err
	}
	defer h.Reg.Unregister(sid)

	select {
	case code = <-exitCh:
		mu.Lock()
		out := buf.Bytes()
		mu.Unlock()
		return out, nil, code, nil
	case <-runCtx.Done():
		h.closeOneShotPTY(serverID, sid)
		return nil, nil, -1, runCtx.Err()
	}
}

// StreamCmd runs name with args on serverID, calling onLine for each
// newline-terminated output line as it arrives. onLine must not block.
// StreamCmd blocks until ctx is cancelled (e.g. the WS client disconnects)
// or the process exits on its own.
func (h *HubHostExec) StreamCmd(ctx context.Context, serverID int64, name string, args []string, onLine func(line string)) error {
	exitCh := make(chan int, 1)
	var remainder string // partial line buffered across frames

	sess := &oneshotSession{
		onOutput: func(p []byte) {
			// Split on newlines; keep any trailing partial line for the next frame.
			chunk := remainder + string(p)
			remainder = ""
			for {
				idx := strings.IndexByte(chunk, '\n')
				if idx < 0 {
					remainder = chunk
					break
				}
				line := chunk[:idx+1]
				chunk = chunk[idx+1:]
				onLine(strings.TrimRight(line, "\r\n"))
			}
		},
		onExit: func(c int) {
			exitCh <- c
		},
	}

	sid, err := h.openOneShotPTY(ctx, serverID, name, args, sess)
	if err != nil {
		return err
	}
	defer h.Reg.Unregister(sid)

	select {
	case <-exitCh:
		// Flush any remaining partial line.
		if remainder != "" {
			onLine(remainder)
		}
		return nil
	case <-ctx.Done():
		h.closeOneShotPTY(serverID, sid)
		return ctx.Err()
	}
}

// openOneShotPTY registers a one-shot PTY consumer in the session registry,
// sends pty.open to the hub, and returns the session ID.
func (h *HubHostExec) openOneShotPTY(ctx context.Context, serverID int64, name string, args []string, sess *oneshotSession) (string, error) {
	sid := agentapi.NewSID()
	sess.sid = sid
	sess.serverID = serverID
	sess.hub = h.Hub

	h.Reg.RegisterPTY(sid, sess)

	exec := shellJoin(name, args)
	openP := agentapi.PTYOpen{
		Sid:  sid,
		Kind: agentapi.PTYKindScript,
		User: "root",
		Rows: 24,
		Cols: 80,
		Term: "xterm-256color",
		Exec: exec,
	}
	env, _ := agentapi.Frame(agentapi.TypePTYOpen, openP)
	if err := h.Hub.Send(serverID, env); err != nil {
		h.Reg.Unregister(sid)
		return "", err
	}
	return sid, nil
}

// closeOneShotPTY sends pty.close to the agent (best-effort; used on ctx cancel).
func (h *HubHostExec) closeOneShotPTY(serverID int64, sid string) {
	env, _ := agentapi.Frame(agentapi.TypePTYClose, agentapi.PTYClose{Sid: sid, Reason: "plugin_cancel"})
	_ = h.Hub.Send(serverID, env)
}

// oneshotSession implements sessionmux.PTYConsumer for a single fire-and-forget
// PTY session used by RunCmd/StreamCmd. It has no DB row and no audit trail.
type oneshotSession struct {
	sid      string
	serverID int64
	hub      hubExecHub
	closed   atomic.Bool

	onOutput func([]byte)
	onExit   func(int)
}

func (s *oneshotSession) DeliverBinary(kind byte, p []byte) {
	if kind != agentapi.KindPTYOut {
		return
	}
	if s.onOutput != nil {
		s.onOutput(p)
	}
}

func (s *oneshotSession) DeliverControl(env agentapi.Envelope) {
	if env.Type != agentapi.TypePTYExit {
		return
	}
	if !s.closed.CompareAndSwap(false, true) {
		return
	}
	var p agentapi.PTYExit
	if err := env.Decode(&p); err != nil {
		p.Code = -1
	}
	if s.onExit != nil {
		s.onExit(p.Code)
	}
}

// shellJoin builds a shell command string by joining name and args with proper
// quoting. Each argument is single-quoted with internal single-quotes escaped.
// This avoids exec.Command (which forks via sh -c) — the PTY agent already
// runs Exec directly under a shell.
func shellJoin(name string, args []string) string {
	parts := make([]string, 0, 1+len(args))
	parts = append(parts, shellQuote(name))
	for _, a := range args {
		parts = append(parts, shellQuote(a))
	}
	return strings.Join(parts, " ")
}

// shellQuote returns a single-quoted shell word safe for embedding in a
// POSIX sh command. Internal single-quotes are escaped as '\''.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
