package agentsvc

import (
	"errors"
	"sync"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

var ErrAgentOffline = errors.New("agent offline")

// Conn is the minimal interface an agent connection must satisfy. Implemented
// by the WebSocket handler in api/agent_routes.go.
type Conn interface {
	Send(env agentapi.Envelope) error
	Close() error
}

type Hub struct {
	mu    sync.Mutex
	conns map[int64]Conn // server_id -> conn
}

func NewHub() *Hub {
	return &Hub{conns: map[int64]Conn{}}
}

// Register replaces any existing conn for serverID and returns the previous conn (if any)
// so the caller can close it. Last-writer-wins keeps the registry consistent across
// reconnects without leaking goroutines.
func (h *Hub) Register(serverID int64, c Conn) Conn {
	h.mu.Lock()
	defer h.mu.Unlock()
	prev := h.conns[serverID]
	h.conns[serverID] = c
	return prev
}

// Unregister removes the entry for serverID *only if* the current conn matches `c`.
// This avoids races where a stale goroutine evicts a fresher reconnect.
func (h *Hub) Unregister(serverID int64, c Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.conns[serverID] == c {
		delete(h.conns, serverID)
	}
}

func (h *Hub) Send(serverID int64, env agentapi.Envelope) error {
	h.mu.Lock()
	c := h.conns[serverID]
	h.mu.Unlock()
	if c == nil {
		return ErrAgentOffline
	}
	return c.Send(env)
}

func (h *Hub) IsOnline(serverID int64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	_, ok := h.conns[serverID]
	return ok
}
