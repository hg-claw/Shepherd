package wsclient

import (
	"context"
	"encoding/json"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/agent/filehandler"
	"github.com/hg-claw/Shepherd/internal/agent/ptyrunner"
	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type runners struct {
	mu  sync.Mutex
	pty map[string]*ptyrunner.Runner
}

func newRunners() *runners { return &runners{pty: map[string]*ptyrunner.Runner{}} }

func (r *runners) addPTY(sid string, run *ptyrunner.Runner) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pty[sid] = run
}

func (r *runners) getPTY(sid string) *ptyrunner.Runner {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.pty[sid]
}

func (r *runners) delPTY(sid string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.pty, sid)
}

func (c *Client) dispatchControl(ctx context.Context, env agentapi.Envelope, fh *filehandler.Handler) {
	switch env.Type {
	case agentapi.TypePing:
		pong, _ := agentapi.Frame(agentapi.TypePong, struct{}{})
		_ = c.writeJSON(pong)
	case agentapi.TypeConfigUpdate:
		c.applyConfig(env, fh)
	case agentapi.TypePTYOpen:
		var p agentapi.PTYOpen
		if err := env.Decode(&p); err == nil {
			c.openPTY(ctx, p)
		}
	case agentapi.TypePTYResize:
		var p agentapi.PTYResize
		if err := env.Decode(&p); err == nil {
			if r := c.runners.getPTY(p.Sid); r != nil {
				_ = r.Resize(p.Rows, p.Cols)
			}
		}
	case agentapi.TypePTYClose:
		var p agentapi.PTYClose
		if err := env.Decode(&p); err == nil {
			if r := c.runners.getPTY(p.Sid); r != nil {
				r.Close(p.Reason)
			}
		}
	case agentapi.TypeFileList:
		var p agentapi.FileList
		if err := env.Decode(&p); err == nil {
			fh.HandleList(p)
		}
	case agentapi.TypeFileStat:
		var p agentapi.FileStat
		if err := env.Decode(&p); err == nil {
			fh.HandleStat(p)
		}
	case agentapi.TypeFileMkdir:
		var p agentapi.FileMkdir
		if err := env.Decode(&p); err == nil {
			fh.HandleMkdir(p)
		}
	case agentapi.TypeFileRename:
		var p agentapi.FileRename
		if err := env.Decode(&p); err == nil {
			fh.HandleRename(p)
		}
	case agentapi.TypeFileRm:
		var p agentapi.FileRm
		if err := env.Decode(&p); err == nil {
			fh.HandleRm(p)
		}
	case agentapi.TypeFileUploadBegin:
		var p agentapi.FileUploadBegin
		if err := env.Decode(&p); err == nil {
			fh.HandleUploadBegin(p)
		}
	case agentapi.TypeFileUploadEnd:
		var p agentapi.FileUploadEnd
		if err := env.Decode(&p); err == nil {
			fh.HandleUploadEnd(p)
		}
	case agentapi.TypeFileDownloadBegin:
		var p agentapi.FileDownloadBegin
		if err := env.Decode(&p); err == nil {
			fh.HandleDownloadBegin(p)
		}
	case agentapi.TypeFileCancel:
		var p agentapi.FileCancel
		if err := env.Decode(&p); err == nil {
			fh.HandleCancel(p)
		}
	}
}

func (c *Client) dispatchBinary(buf []byte, fh *filehandler.Handler) {
	sid, kind, payload, err := agentapi.DecodeBinary(buf)
	if err != nil {
		return
	}
	switch kind {
	case agentapi.KindPTYIn:
		if r := c.runners.getPTY(sid); r != nil {
			_ = r.Write(payload)
		}
	case agentapi.KindFileChunk:
		fh.HandleUploadChunk(sid, payload)
	}
}

func (c *Client) readPump(ctx context.Context, conn *websocket.Conn, fh *filehandler.Handler) error {
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		switch mt {
		case websocket.TextMessage:
			var env agentapi.Envelope
			if err := json.Unmarshal(data, &env); err == nil {
				c.dispatchControl(ctx, env, fh)
			}
		case websocket.BinaryMessage:
			c.dispatchBinary(data, fh)
		}
	}
}
