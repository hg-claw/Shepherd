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
//
// WriteJSON may be called concurrently — Publish (agent read loop) and Attach
// (browser handler) can both target a freshly-registered conn — so
// implementations MUST serialize their own writes. The production wsLiveConn
// holds a per-conn mutex; test fakes used across goroutines do the same.
type Conn interface {
	WriteJSON(v any) error
}

type serverState struct {
	ring     []agentapi.LiveNetSample
	watchers map[Conn]struct{}
}

// Hub fans out live samples to browser watchers, per server. Safe for
// concurrent use; conn writes happen outside the hub lock (bounded by the
// connection's own write deadline), so a stalled client cannot block other
// servers or the agent read loop.
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
// server's watchers. Writes happen outside the hub lock so a stalled client
// cannot block other servers or the agent read loop; a watcher whose write
// fails is removed.
func (h *Hub) Publish(serverID int64, s agentapi.LiveNetSample) {
	h.mu.Lock()
	st := h.stateLocked(serverID)
	st.ring = append(st.ring, s)
	if len(st.ring) > ringSize {
		st.ring = st.ring[len(st.ring)-ringSize:]
	}
	watchers := make([]Conn, 0, len(st.watchers))
	for c := range st.watchers {
		watchers = append(watchers, c)
	}
	h.mu.Unlock()

	var failed []Conn
	for _, c := range watchers {
		if err := c.WriteJSON(s); err != nil {
			failed = append(failed, c)
		}
	}
	if len(failed) > 0 {
		h.mu.Lock()
		if st := h.servers[serverID]; st != nil {
			for _, c := range failed {
				delete(st.watchers, c)
			}
		}
		h.mu.Unlock()
	}
}

// Attach registers c as a watcher and replays the current ring (backfill) for
// immediate paint. The ring snapshot + registration happen under the lock; the
// backfill writes happen outside it. If a backfill write fails, c is removed
// and a no-op detach is returned. The returned func deregisters the watcher.
func (h *Hub) Attach(serverID int64, c Conn) func() {
	h.mu.Lock()
	st := h.stateLocked(serverID)
	backfill := make([]agentapi.LiveNetSample, len(st.ring))
	copy(backfill, st.ring)
	st.watchers[c] = struct{}{}
	h.mu.Unlock()

	for _, s := range backfill {
		if err := c.WriteJSON(s); err != nil {
			h.remove(serverID, c)
			return func() {}
		}
	}
	return func() { h.remove(serverID, c) }
}

// remove deregisters a watcher (idempotent).
func (h *Hub) remove(serverID int64, c Conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if st := h.servers[serverID]; st != nil {
		delete(st.watchers, c)
	}
}
