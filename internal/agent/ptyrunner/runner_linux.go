//go:build linux

package ptyrunner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/creack/pty"
	"github.com/hg-claw/Shepherd/internal/agentapi"
)

var validUser = regexp.MustCompile(`^[a-z_][a-z0-9_-]{0,31}$`)

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

	var argv []string
	useRoot := opts.User == "" || opts.User == "root"
	switch {
	case opts.Kind == "console" && useRoot:
		argv = []string{"/bin/bash", "-l"}
	case opts.Kind == "console":
		argv = []string{"/bin/su", "-l", opts.User}
	case opts.Kind == "script" && useRoot:
		argv = []string{"/bin/bash", "-lc", opts.Exec}
	default:
		argv = []string{"/bin/su", "-l", opts.User, "-c", opts.Exec}
	}

	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = []string{
		"TERM=" + opts.Term,
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"HOME=/root",
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

func (r *Runner) readLoop(sender Sender) {
	buf := make([]byte, 16*1024)
	flush := make([]byte, 0, 4096)
	timer := time.NewTimer(20 * time.Millisecond)
	timer.Stop()
	emit := func() {
		if len(flush) == 0 {
			return
		}
		_ = sender.SendBinary(r.sid, agentapi.KindPTYOut, append([]byte(nil), flush...))
		flush = flush[:0]
	}
	for {
		n, err := r.ptmx.Read(buf)
		if n > 0 {
			flush = append(flush, buf[:n]...)
			if len(flush) >= 4096 {
				emit()
			} else {
				timer.Reset(20 * time.Millisecond)
				select {
				case <-timer.C:
					emit()
				default:
				}
			}
		}
		if err != nil {
			emit()
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
