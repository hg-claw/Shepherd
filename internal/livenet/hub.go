// Package livenet holds the in-memory fan-out hub for ~1s live network
// throughput. State is ephemeral (latest sample + a short ring per server +
// the set of attached browser watchers); nothing is persisted.
package livenet

import (
	"sync"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// ringSize bounds the per-server backfill replayed to a newly attached watcher
// (≈ the sparkline window at 1s resolution).
const ringSize = 60

// Conn is the minimal browser-connection sink the hub writes to. *websocket.Conn
// satisfies it; tests use a fake.
type Conn interface {
	WriteJSON(v any) error
}

type serverState struct {
	ring     []agentapi.LiveNetSample
	watchers map[Conn]struct{}
}

// Hub fans out live samples to browser watchers, per server. Safe for
// concurrent use; all conn writes happen under the hub lock (bounded by the
// connection's own write deadline), so a stalled client can't corrupt state.
type Hub struct {
	mu      sync.Mutex
	servers map[int64]*serverState
}

func NewHub() *Hub { return &Hub{servers: map[int64]*serverState{}} }

func (h *Hub) stateLocked(serverID int64) *serverState {
	st := h.servers[serverID]
	if st == nil {
		st = &serverState{watchers: map[Conn]struct{}{}}
		h.servers[serverID] = st
	}
	return st
}

// Publish records a sample (updating the ring) and broadcasts it to the
// server's watchers. A watcher whose write fails is dropped.
func (h *Hub) Publish(serverID int64, s agentapi.LiveNetSample) {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := h.stateLocked(serverID)
	st.ring = append(st.ring, s)
	if len(st.ring) > ringSize {
		st.ring = st.ring[len(st.ring)-ringSize:]
	}
	for c := range st.watchers {
		if err := c.WriteJSON(s); err != nil {
			delete(st.watchers, c)
		}
	}
}

// Attach replays the current ring to c (immediate paint), then registers it as
// a watcher. If the backfill write fails the conn is not registered. The
// returned func deregisters the watcher.
func (h *Hub) Attach(serverID int64, c Conn) func() {
	h.mu.Lock()
	defer h.mu.Unlock()
	st := h.stateLocked(serverID)
	for _, s := range st.ring {
		if err := c.WriteJSON(s); err != nil {
			return func() {}
		}
	}
	st.watchers[c] = struct{}{}
	return func() {
		h.mu.Lock()
		defer h.mu.Unlock()
		if s := h.servers[serverID]; s != nil {
			delete(s.watchers, c)
		}
	}
}
