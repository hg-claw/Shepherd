//go:build linux || darwin

package ptyrunner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/hg-claw/Shepherd/internal/agentapi"
)

var validUser = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

// resolveBinary returns the absolute path of name from PATH, falling back to
// the literal name (creack/pty + exec will then return its own ENOENT).
// Used to paper over /bin/su (linux) vs /usr/bin/su (darwin) and similar.
func resolveBinary(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	return name
}

// defaultShell picks the user's preferred login shell: zsh if installed
// (default on modern macOS), bash otherwise (default on most Linux distros),
// /bin/sh as a POSIX-only fallback. Used for the root-side `console` and
// `script` paths; non-root paths invoke `su -l <user>` which already honors
// the target user's shell from /etc/passwd.
func defaultShell() string {
	for _, name := range []string{"zsh", "bash"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return "/bin/sh"
}

type Sender interface {
	SendBinary(sid string, kind byte, p []byte) error
	SendExit(sid string, code int)
}

type SpawnOpts struct {
	SID  string
	Kind string
	User string
	Rows int
	Cols int
	Term string
	Exec string
	Env  map[string]string
}

type Runner struct {
	sid    string
	cmd    *exec.Cmd
	ptmx   *os.File
	closed atomic.Bool
}

func Spawn(ctx context.Context, opts SpawnOpts, sender Sender) (*Runner, error) {
	if opts.User != "" && opts.User != "root" && !validUser.MatchString(opts.User) {
		return nil, fmt.Errorf("invalid user")
	}
	if opts.Term == "" {
		opts.Term = "xterm-256color"
	}
	if opts.Rows == 0 {
		opts.Rows = 24
	}
	if opts.Cols == 0 {
		opts.Cols = 80
	}

	shell := defaultShell()
	suPath := resolveBinary("su")

	var argv []string
	useRoot := opts.User == "" || opts.User == "root"
	switch {
	case opts.Kind == "console" && useRoot:
		argv = []string{shell, "-l"}
	case opts.Kind == "console":
		argv = []string{suPath, "-l", opts.User}
	case opts.Kind == "script" && useRoot:
		argv = []string{shell, "-lc", opts.Exec}
	default:
		argv = []string{suPath, "-l", opts.User, "-c", opts.Exec}
	}

	defaultPath := "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	if runtime.GOOS == "darwin" {
		// /opt/homebrew/bin for Apple Silicon brew installs.
		defaultPath = "/opt/homebrew/bin:" + defaultPath
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = []string{
		"TERM=" + opts.Term,
		"PATH=" + defaultPath,
		"HOME=" + os.Getenv("HOME"), // best-effort; root pty inherits agent's HOME
	}
	for k, v := range opts.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Rows: uint16(opts.Rows), Cols: uint16(opts.Cols)})
	if err != nil {
		return nil, err
	}

	r := &Runner{sid: opts.SID, cmd: cmd, ptmx: ptmx}
	go r.readLoop(sender)
	go r.waitLoop(sender)
	return r, nil
}

// readLoop reads from the PTY master and emits pty.out frames on either
// 4 KiB accumulated OR every 20 ms (whichever comes first), so an interactive
// shell prompt of a few bytes still streams promptly without paying a frame
// per byte for high-throughput output.
//
// The flush timer runs in its own goroutine because ptmx.Read blocks; you
// cannot combine a blocking syscall with a timer in the same goroutine
// without a channel.
func (r *Runner) readLoop(sender Sender) {
	buf := make([]byte, 16*1024)
	var (
		mu      sync.Mutex
		pending []byte
	)
	flushNow := func() {
		mu.Lock()
		if len(pending) == 0 {
			mu.Unlock()
			return
		}
		out := pending
		pending = nil
		mu.Unlock()
		_ = sender.SendBinary(r.sid, agentapi.KindPTYOut, out)
	}

	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(20 * time.Millisecond)
		defer t.Stop()
		for {
			select {
			case <-stop:
				flushNow()
				return
			case <-t.C:
				flushNow()
			}
		}
	}()
	defer close(stop)

	for {
		n, err := r.ptmx.Read(buf)
		if n > 0 {
			mu.Lock()
			pending = append(pending, buf[:n]...)
			full := len(pending) >= 4096
			mu.Unlock()
			if full {
				flushNow()
			}
		}
		if err != nil {
			flushNow()
			return
		}
	}
}

func (r *Runner) waitLoop(sender Sender) {
	err := r.cmd.Wait()
	code := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else {
			code = -1
		}
	}
	sender.SendExit(r.sid, code)
}

func (r *Runner) Write(p []byte) error {
	_, err := r.ptmx.Write(p)
	return err
}

func (r *Runner) Resize(rows, cols int) error {
	return pty.Setsize(r.ptmx, &pty.Winsize{Rows: uint16(rows), Cols: uint16(cols)})
}

func (r *Runner) Close(_ string) {
	if !r.closed.CompareAndSwap(false, true) {
		return
	}
	if r.cmd.Process != nil {
		pgid, err := syscall.Getpgid(r.cmd.Process.Pid)
		if err == nil {
			_ = syscall.Kill(-pgid, syscall.SIGTERM)
			done := make(chan struct{})
			go func() { _, _ = r.cmd.Process.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				_ = syscall.Kill(-pgid, syscall.SIGKILL)
			}
		}
	}
	_ = r.ptmx.Close()
}
