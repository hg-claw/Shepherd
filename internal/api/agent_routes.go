package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
)

const (
	wsWriteTimeout = 10 * time.Second
	wsPingInterval = 30 * time.Second
	wsPongWait     = 90 * time.Second
)

type AgentAPI struct {
	Agents  *agentsvc.Service
	Hub     *agentsvc.Hub
	OnFrame FrameHandler // injected by router; receives agent->server envelopes
}

// FrameHandler dispatches agent→server frames. Implemented by ingest pipeline (Task 13).
type FrameHandler func(ctx context.Context, serverID int64, env agentapi.Envelope)

func (a *AgentAPI) Enroll(w http.ResponseWriter, r *http.Request) {
	var req agentapi.EnrollRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	machine, sid, err := a.Agents.RedeemEnrollment(r.Context(), req.EnrollmentToken,
		req.Fingerprint, req.OS, req.Arch, req.Kernel, req.AgentVersion)
	if err != nil {
		writeError(w, http.StatusUnauthorized, err.Error())
		return
	}
	writeJSON(w, 200, agentapi.EnrollResponse{MachineToken: machine, ServerID: sid})
}

func (a *AgentAPI) AutoRegister(w http.ResponseWriter, r *http.Request) {
	var req agentapi.AutoRegisterRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	machine, sid, err := a.Agents.AutoRegister(r.Context(), req.AutoRecoverKey,
		req.Fingerprint, req.Hostname, req.OS, req.Arch, req.Kernel, req.AgentVersion)
	if err != nil {
		status := http.StatusUnauthorized
		if errors.Is(err, agentsvc.ErrAutoRegisterDisabled) {
			status = http.StatusForbidden
		}
		writeError(w, status, err.Error())
		return
	}
	writeJSON(w, 200, agentapi.EnrollResponse{MachineToken: machine, ServerID: sid})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin:     func(r *http.Request) bool { return true }, // agent has bearer auth instead
}

// WS handles /agent/ws upgrade. Bearer machine_token in Authorization header.
func (a *AgentAPI) WS(w http.ResponseWriter, r *http.Request) {
	tok := bearerToken(r.Header.Get("Authorization"))
	if tok == "" {
		writeError(w, 401, "missing bearer")
		return
	}
	sid, err := a.Agents.AuthenticateMachineToken(r.Context(), tok)
	if err != nil {
		writeError(w, 401, "bad token")
		return
	}

	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}

	conn := &wsConn{c: c}
	if prev := a.Hub.Register(sid, conn); prev != nil {
		_ = prev.Close()
	}
	defer func() {
		a.Hub.Unregister(sid, conn)
		_ = conn.Close()
	}()

	_ = c.SetReadDeadline(time.Now().Add(wsPongWait))
	c.SetPongHandler(func(string) error {
		_ = c.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	stop := make(chan struct{})
	go a.pingLoop(conn, stop)
	defer close(stop)

	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return
		}
		var env agentapi.Envelope
		if err := envDecode(data, &env); err != nil {
			log.Printf("ws decode: %v", err)
			continue
		}
		switch env.Type {
		case agentapi.TypePong:
			_ = c.SetReadDeadline(time.Now().Add(wsPongWait))
		default:
			if a.OnFrame != nil {
				a.OnFrame(r.Context(), sid, env)
			}
		}
	}
}

func (a *AgentAPI) pingLoop(c *wsConn, stop <-chan struct{}) {
	t := time.NewTicker(wsPingInterval)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			env, _ := agentapi.Frame(agentapi.TypePing, struct{}{})
			_ = c.Send(env)
		}
	}
}

func bearerToken(h string) string {
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// wsConn satisfies agentsvc.Conn.
type wsConn struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (w *wsConn) Send(env agentapi.Envelope) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.c.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	return w.c.WriteJSON(env)
}

func (w *wsConn) SendBinary([]byte) error { return nil }

func (w *wsConn) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.c.Close()
}
