package api

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

const (
	wsWriteTimeout = 10 * time.Second
	wsPingInterval = 30 * time.Second
	wsPongWait     = 90 * time.Second
)

type AgentAPI struct {
	Agents            *agentsvc.Service
	Hub               *agentsvc.Hub
	OnFrame           FrameHandler // injected by router; receives agent->server envelopes
	Reg               *sessionmux.Registry
	OnAgentDisconnect func(serverID int64)
	PushSandbox       func(serverID int64)
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

	adapter := &wsAdapter{c: c}
	ws := agentsvc.NewWSConn(adapter, 256, 100*time.Millisecond)
	bc := &bridgedConn{w: ws}
	prev := a.Hub.Register(sid, bc)
	if prev != nil {
		_ = prev.Close()
	}
	defer func() {
		a.Hub.Unregister(sid, bc)
		_ = bc.Close()
		if a.OnAgentDisconnect != nil {
			a.OnAgentDisconnect(sid)
		}
	}()

	if a.PushSandbox != nil {
		a.PushSandbox(sid)
	}

	_ = c.SetReadDeadline(time.Now().Add(wsPongWait))
	c.SetPongHandler(func(string) error {
		_ = c.SetReadDeadline(time.Now().Add(wsPongWait))
		return nil
	})

	stop := make(chan struct{})
	defer close(stop)
	go a.pingLoop(bc, stop)

	for {
		mt, data, err := c.ReadMessage()
		if err != nil {
			return
		}
		switch mt {
		case websocket.TextMessage:
			var env agentapi.Envelope
			if err := json.Unmarshal(data, &env); err != nil {
				continue
			}
			if a.Reg != nil && a.Reg.Deliver(env) {
				continue
			}
			if a.OnFrame != nil {
				a.OnFrame(r.Context(), sid, env)
			}
		case websocket.BinaryMessage:
			sid2, kind, payload, err := agentapi.DecodeBinary(data)
			if err != nil {
				continue
			}
			if a.Reg != nil {
				a.Reg.DeliverBinary(sid2, kind, payload)
			}
		}
	}
}

func (a *AgentAPI) pingLoop(c agentsvc.Conn, stop <-chan struct{}) {
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

// wsAdapter adapts *websocket.Conn to agentsvc.RawWriter.
type wsAdapter struct {
	c  *websocket.Conn
	mu sync.Mutex
}

func (a *wsAdapter) WriteFrame(f agentsvc.OutFrame) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	_ = a.c.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
	if f.Text != nil {
		return a.c.WriteMessage(websocket.TextMessage, f.Text)
	}
	return a.c.WriteMessage(websocket.BinaryMessage, f.Binary)
}

func (a *wsAdapter) Close() error { return a.c.Close() }

// bridgedConn satisfies agentsvc.Conn backed by agentsvc.WSConn (single-writer goroutine).
type bridgedConn struct {
	w *agentsvc.WSConn
}

func (b *bridgedConn) Send(env agentapi.Envelope) error {
	buf, _ := json.Marshal(env)
	return b.w.Send(agentsvc.OutFrame{Text: buf})
}

func (b *bridgedConn) SendBinary(buf []byte) error {
	return b.w.Send(agentsvc.OutFrame{Binary: buf})
}

func (b *bridgedConn) Close() error {
	b.w.Close()
	return nil
}
