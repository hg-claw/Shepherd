package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type PluginLogsAPI struct {
	HostExec plugins.HostExec
	Deps     plugins.Deps
}

var logsUpgrader = websocket.Upgrader{
	ReadBufferSize:  4 * 1024,
	WriteBufferSize: 16 * 1024,
	CheckOrigin:     func(*http.Request) bool { return true },
}

type logEnvelope struct {
	TS    string `json:"ts"`
	Level string `json:"level"`
	Line  string `json:"line"`
}

const maxLogLineBytes = 8 * 1024

func (a *PluginLogsAPI) AttachWS(w http.ResponseWriter, r *http.Request) {
	// path-style + query-style both supported; production uses path.
	id := r.PathValue("id")
	if id == "" {
		id = r.URL.Query().Get("id")
	}
	serverIDStr := r.PathValue("server_id")
	if serverIDStr == "" {
		serverIDStr = r.URL.Query().Get("server_id")
	}
	serverID, err := strconv.ParseInt(serverIDStr, 10, 64)
	if err != nil {
		writeError(w, 400, "bad server_id")
		return
	}

	p, ok := plugins.Get(id)
	if !ok {
		writeError(w, 404, "unknown plugin")
		return
	}
	ls, ok := p.(plugins.LogStreamer)
	if !ok {
		writeError(w, 404, "no log stream")
		return
	}
	cmd, args, err := ls.LogStreamCommand(r.Context(), a.Deps, serverID)
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}

	conn, err := logsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = conn.Close() }()
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	var writeMu sync.Mutex
	emit := func(line string) {
		if len(line) > maxLogLineBytes {
			line = line[:maxLogLineBytes] + "…[truncated]"
		}
		env := logEnvelope{
			TS:    time.Now().UTC().Format(time.RFC3339),
			Level: "info",
			Line:  line,
		}
		b, _ := json.Marshal(env)
		writeMu.Lock()
		defer writeMu.Unlock()
		_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = conn.WriteMessage(websocket.TextMessage, b)
	}

	go func() {
		// detect client disconnect → cancel streaming
		for {
			if _, _, err := conn.NextReader(); err != nil {
				cancel()
				return
			}
		}
	}()

	if err := a.HostExec.StreamCmd(ctx, serverID, cmd, args, emit); err != nil {
		emit("stream error: " + err.Error())
	}
}
