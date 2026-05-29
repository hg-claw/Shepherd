package api

import (
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/hg-claw/Shepherd/internal/auth"
	"github.com/hg-claw/Shepherd/internal/livenet"
)

type LiveNetAPI struct {
	Hub *livenet.Hub
}

var liveNetUpgrader = websocket.Upgrader{
	ReadBufferSize: 1024, WriteBufferSize: 4 * 1024,
	CheckOrigin: func(*http.Request) bool { return true },
}

// wsLiveConn adapts *websocket.Conn to livenet.Conn with a write deadline so a
// stalled browser can't block the hub indefinitely.
type wsLiveConn struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (c *wsLiveConn) WriteJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return c.conn.WriteJSON(v)
}

// AttachWS streams ~1s live throughput for one server to an admin browser.
func (a *LiveNetAPI) AttachWS(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.AdminFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "unauth")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, 400, "bad id")
		return
	}
	conn, err := liveNetUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	detach := a.Hub.Attach(id, &wsLiveConn{conn: conn})
	defer detach()
	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			return
		}
	}
}
