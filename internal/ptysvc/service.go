package ptysvc

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/audit"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

type Hub interface {
	Send(serverID int64, env agentapi.Envelope) error
	SendBinary(serverID int64, sid string, kind byte, payload []byte) error
}

type BrowserConn interface {
	WriteBinary([]byte) error
	WriteText([]byte) error
	Close() error
}

type Service struct {
	DB            *sqlx.DB
	Hub           Hub
	Reg           *sessionmux.Registry
	Audit         *audit.Writer
	Now           func() time.Time
	RecordingsDir string

	OnSessionFinalized func(ptyRowID int64, code int, reason string)

	mu       sync.Mutex
	sessions map[string]*Session
}

type OpenOpts struct {
	AdminID  int64
	ServerID int64
	Kind     string
	User     string
	Rows     int
	Cols     int
	Term     string
	Exec     string
	Env      map[string]string
	TimeoutS int
	Browser  BrowserConn
}

type Session struct {
	SID      string
	PTYRowID int64
	ServerID int64
	AdminID  int64
	Kind     string
	Started  time.Time
	Recorder *CastWriter
	browser  atomic.Value
	closed   atomic.Bool
	svc      *Service
}

func (s *Session) AttachBrowser(b BrowserConn) { s.browser.Store(b) }

func (s *Session) DeliverBinary(kind byte, p []byte) {
	if kind != agentapi.KindPTYOut {
		return
	}
	if s.Recorder != nil {
		s.Recorder.WriteOutput(time.Since(s.Started), p)
	}
	if v := s.browser.Load(); v != nil {
		if b, ok := v.(BrowserConn); ok && b != nil {
			_ = b.WriteBinary(p)
		}
	}
}

func (s *Session) DeliverControl(env agentapi.Envelope) {
	if env.Type != agentapi.TypePTYExit {
		return
	}
	var p agentapi.PTYExit
	if err := env.Decode(&p); err != nil {
		return
	}
	s.svc.OnExit(s.SID, p.Code)
}

func (s *Service) Open(ctx context.Context, o OpenOpts) (*Session, error) {
	if s.Now == nil {
		s.Now = time.Now
	}
	if s.sessions == nil {
		s.sessions = map[string]*Session{}
	}
	if o.Term == "" {
		o.Term = "xterm-256color"
	}
	if o.Rows == 0 {
		o.Rows = 24
	}
	if o.Cols == 0 {
		o.Cols = 80
	}
	sid := agentapi.NewSID()
	now := s.Now().UTC()

	res, err := s.DB.ExecContext(ctx, `INSERT INTO pty_sessions
		(server_id, admin_id, kind, exec_user, rows, cols, exec, started_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		o.ServerID, o.AdminID, o.Kind, ifEmpty(o.User, "root"), o.Rows, o.Cols, o.Exec, now)
	if err != nil {
		return nil, err
	}
	id, _ := res.LastInsertId()

	recPath := filepath.Join(s.RecordingsDir, fmt.Sprintf("%d", o.ServerID), fmt.Sprintf("%d.cast", id))
	rec, recErr := NewCastWriter(recPath, o.Cols, o.Rows, now, "shepherd-pty", fmt.Sprintf("kind=%s", o.Kind))
	if recErr == nil {
		_, _ = s.DB.ExecContext(ctx, `UPDATE pty_sessions SET recording_path=? WHERE id=?`, recPath, id)
	}

	sess := &Session{
		SID:      sid,
		PTYRowID: id,
		ServerID: o.ServerID,
		AdminID:  o.AdminID,
		Kind:     o.Kind,
		Started:  now,
		Recorder: rec,
		svc:      s,
	}
	if o.Browser != nil {
		sess.AttachBrowser(o.Browser)
	}
	s.mu.Lock()
	s.sessions[sid] = sess
	s.mu.Unlock()
	s.Reg.RegisterPTY(sid, sess)

	openP := agentapi.PTYOpen{
		Sid:      sid,
		Kind:     o.Kind,
		User:     o.User,
		Rows:     o.Rows,
		Cols:     o.Cols,
		Term:     o.Term,
		Exec:     o.Exec,
		Env:      o.Env,
		TimeoutS: o.TimeoutS,
	}
	env, _ := agentapi.Frame(agentapi.TypePTYOpen, openP)
	if err := s.Hub.Send(o.ServerID, env); err != nil {
		if sess.Recorder != nil {
			_ = sess.Recorder.Close()
		}
		_, _ = s.DB.ExecContext(ctx, `UPDATE pty_sessions SET ended_at=?, ended_reason='agent_offline' WHERE id=?`, s.Now().UTC(), id)
		s.mu.Lock()
		delete(s.sessions, sid)
		s.mu.Unlock()
		s.Reg.Unregister(sid)
		return nil, err
	}

	if o.Kind == "script" && o.TimeoutS > 0 {
		time.AfterFunc(time.Duration(o.TimeoutS)*time.Second, func() {
			s.Close(sid, "timeout")
		})
	}

	s.Audit.Write(ctx, &o.AdminID, &o.ServerID, "pty.open", map[string]any{
		"kind": o.Kind, "user": ifEmpty(o.User, "root"), "rows": o.Rows, "cols": o.Cols,
		"timeout_s": o.TimeoutS,
	}, nil)
	return sess, nil
}

func (s *Service) Close(sid, reason string) {
	s.mu.Lock()
	sess := s.sessions[sid]
	s.mu.Unlock()
	if sess == nil || sess.closed.Load() {
		return
	}
	closeEnv, _ := agentapi.Frame(agentapi.TypePTYClose, agentapi.PTYClose{Sid: sid, Reason: reason})
	_ = s.Hub.Send(sess.ServerID, closeEnv)
	time.AfterFunc(7*time.Second, func() {
		if !sess.closed.Load() {
			s.finalize(sess, -3, "agent_unresponsive")
		}
	})
}

func (s *Service) OnExit(sid string, code int) {
	s.mu.Lock()
	sess := s.sessions[sid]
	s.mu.Unlock()
	if sess == nil {
		return
	}
	s.finalize(sess, code, "exit")
}

func (s *Service) finalize(sess *Session, code int, reason string) {
	if !sess.closed.CompareAndSwap(false, true) {
		return
	}
	if sess.Recorder != nil {
		_ = sess.Recorder.Close()
	}
	now := s.Now().UTC()
	_, _ = s.DB.Exec(`UPDATE pty_sessions SET ended_at=?, exit_code=?, ended_reason=? WHERE id=?`,
		now, code, reason, sess.PTYRowID)
	if v := sess.browser.Load(); v != nil {
		if b, ok := v.(BrowserConn); ok && b != nil {
			_ = b.WriteText([]byte(fmt.Sprintf(`{"op":"exited","code":%d}`, code)))
			_ = b.Close()
		}
	}
	s.mu.Lock()
	delete(s.sessions, sess.SID)
	s.mu.Unlock()
	s.Reg.Unregister(sess.SID)
	s.Audit.Write(context.Background(), &sess.AdminID, &sess.ServerID, "pty.close", map[string]any{
		"exit_code": code, "duration_s": int(now.Sub(sess.Started).Seconds()), "ended_reason": reason,
	}, nil)
	if s.OnSessionFinalized != nil {
		s.OnSessionFinalized(sess.PTYRowID, code, reason)
	}
}

func (s *Service) AgentDisconnected(serverID int64) {
	s.mu.Lock()
	var victims []*Session
	for _, sess := range s.sessions {
		if sess.ServerID == serverID {
			victims = append(victims, sess)
		}
	}
	s.mu.Unlock()
	for _, v := range victims {
		s.finalize(v, -2, "agent_disconnected")
	}
}

func (s *Service) Sweep(ctx context.Context) error {
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE pty_sessions SET ended_at=?, exit_code=-4, ended_reason='server_restart' WHERE ended_at IS NULL`, now)
	return err
}

func ifEmpty(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// AttachBrowserBySID looks up a session by SID and attaches the browser conn.
// Returns false if the session is unknown or already closed.
func (s *Service) AttachBrowserBySID(sid string, b BrowserConn) bool {
	s.mu.Lock()
	sess := s.sessions[sid]
	s.mu.Unlock()
	if sess == nil || sess.closed.Load() {
		return false
	}
	sess.AttachBrowser(b)
	return true
}

// Detach is called when the browser conn closes. The session continues until pty.exit;
// further pty.out broadcasts to a closed conn will simply WriteBinary error and be discarded.
func (s *Service) Detach(sid string) {
	// No-op for v1 — DeliverBinary's WriteBinary will silently no-op once the browser conn is closed.
}

// Resize forwards a winsize change to the agent.
func (s *Service) Resize(sid string, rows, cols int) error {
	s.mu.Lock()
	sess := s.sessions[sid]
	s.mu.Unlock()
	if sess == nil {
		return errors.New("unknown session")
	}
	env, _ := agentapi.Frame(agentapi.TypePTYResize, agentapi.PTYResize{Sid: sid, Rows: rows, Cols: cols})
	return s.Hub.Send(sess.ServerID, env)
}

// Input forwards browser stdin bytes to the agent as a binary pty.in frame.
func (s *Service) Input(sid string, data []byte) error {
	s.mu.Lock()
	sess := s.sessions[sid]
	s.mu.Unlock()
	if sess == nil {
		return errors.New("unknown session")
	}
	return s.Hub.SendBinary(sess.ServerID, sid, agentapi.KindPTYIn, data)
}
