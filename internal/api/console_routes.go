package api

import (
	"encoding/json"
	"net/http"

	"github.com/gorilla/websocket"

	"github.com/hg-claw/Shepherd/internal/auth"
	"github.com/hg-claw/Shepherd/internal/ptysvc"
)

type ConsoleAPI struct {
	PTY *ptysvc.Service
}

type openReq struct {
	ServerID int64  `json:"server_id"`
	User     string `json:"user"`
	Rows     int    `json:"rows"`
	Cols     int    `json:"cols"`
	Term     string `json:"term"`
}
type openResp struct {
	SessionID int64  `json:"session_id"`
	SID       string `json:"sid"`
}

func (a *ConsoleAPI) Open(w http.ResponseWriter, r *http.Request) {
	admin, ok := auth.AdminFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauth")
		return
	}
	var req openReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	sess, err := a.PTY.Open(r.Context(), ptysvc.OpenOpts{
		AdminID: admin.ID, ServerID: req.ServerID, Kind: "console",
		User: req.User, Rows: req.Rows, Cols: req.Cols, Term: req.Term,
	})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, 200, openResp{SessionID: sess.PTYRowID, SID: sess.SID})
}

var consoleUpgrader = websocket.Upgrader{
	ReadBufferSize: 16 * 1024, WriteBufferSize: 16 * 1024,
	CheckOrigin: func(*http.Request) bool { return true },
}

func (a *ConsoleAPI) AttachWS(w http.ResponseWriter, r *http.Request) {
	if _, ok := auth.AdminFromContext(r.Context()); !ok {
		writeError(w, http.StatusUnauthorized, "unauth")
		return
	}
	sidParam := r.URL.Query().Get("sid")
	if sidParam == "" {
		writeError(w, 400, "missing sid")
		return
	}
	conn, err := consoleUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	bc := &browserBridge{conn: conn}
	if !a.PTY.AttachBrowserBySID(sidParam, bc) {
		_ = conn.WriteMessage(websocket.TextMessage, []byte(`{"op":"error","detail":"unknown session"}`))
		_ = conn.Close()
		return
	}
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			a.PTY.Detach(sidParam)
			return
		}
		switch mt {
		case websocket.TextMessage:
			var ctrl struct {
				Op   string `json:"op"`
				Rows int
				Cols int
			}
			if err := json.Unmarshal(data, &ctrl); err == nil && ctrl.Op == "resize" {
				_ = a.PTY.Resize(sidParam, ctrl.Rows, ctrl.Cols)
			}
		case websocket.BinaryMessage:
			_ = a.PTY.Input(sidParam, data)
		}
	}
}

type browserBridge struct {
	conn *websocket.Conn
}

func (b *browserBridge) WriteBinary(p []byte) error {
	return b.conn.WriteMessage(websocket.BinaryMessage, p)
}
func (b *browserBridge) WriteText(p []byte) error {
	return b.conn.WriteMessage(websocket.TextMessage, p)
}
func (b *browserBridge) Close() error { return b.conn.Close() }
