package filehandler

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"os"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type uploadXfer struct {
	target  string
	temp    string
	mode    os.FileMode
	size    int64
	written int64
	hash    hash.Hash
	f       *os.File
}

func (h *Handler) HandleUploadBegin(req agentapi.FileUploadBegin) {
	err := h.sandboxCheck(req.Path, false)
	if err != nil {
		h.sendUploadAck(req.Sid, err)
		return
	}
	mode := os.FileMode(req.Mode & 0o777)
	if mode == 0 {
		mode = 0o644
	}
	temp := req.Path + ".shep-uploading-" + req.Sid
	f, err := os.OpenFile(temp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		h.sendUploadAck(req.Sid, err)
		return
	}
	x := &uploadXfer{
		target: req.Path, temp: temp, mode: mode, size: req.Size,
		hash: sha256.New(), f: f,
	}
	h.transfers.Store(req.Sid, x)
	h.sendUploadAckOK(req.Sid)
}

func (h *Handler) HandleUploadChunk(sid string, p []byte) {
	v, ok := h.transfers.Load(sid)
	if !ok {
		return
	}
	x := v.(*uploadXfer)
	x.written += int64(len(p))
	if x.size > 0 && x.written > x.size {
		_ = x.f.Close()
		_ = os.Remove(x.temp)
		h.transfers.Delete(sid)
		h.sendUploadAck(sid, errors.New("oversize"))
		return
	}
	if _, err := x.f.Write(p); err != nil {
		_ = x.f.Close()
		_ = os.Remove(x.temp)
		h.transfers.Delete(sid)
		h.sendUploadAck(sid, err)
		return
	}
	x.hash.Write(p)
}

func (h *Handler) HandleUploadEnd(req agentapi.FileUploadEnd) {
	v, ok := h.transfers.LoadAndDelete(req.Sid)
	if !ok {
		h.sendUploadAck(req.Sid, errors.New("unknown sid"))
		return
	}
	x := v.(*uploadXfer)
	defer func() { _ = x.f.Close() }()
	if err := x.f.Sync(); err != nil {
		_ = os.Remove(x.temp)
		h.sendUploadAck(req.Sid, err)
		return
	}
	got := hex.EncodeToString(x.hash.Sum(nil))
	if req.SHA256 != "" && got != req.SHA256 {
		_ = os.Remove(x.temp)
		h.sendUploadAck(req.Sid, errors.New("sha256 mismatch"))
		return
	}
	if err := os.Chmod(x.temp, x.mode); err != nil {
		_ = os.Remove(x.temp)
		h.sendUploadAck(req.Sid, err)
		return
	}
	if err := os.Rename(x.temp, x.target); err != nil {
		_ = os.Remove(x.temp)
		h.sendUploadAck(req.Sid, err)
		return
	}
	h.sendUploadAckOK(req.Sid)
}

func (h *Handler) sendUploadAck(sid string, err error) {
	ack := agentapi.FileUploadAck{Sid: sid, OK: err == nil}
	if err != nil {
		ack.Error = err.Error()
	}
	env, _ := agentapi.FrameSid(agentapi.TypeFileUploadAck, sid, ack)
	_ = h.sender.SendControl(env)
}

func (h *Handler) sendUploadAckOK(sid string) { h.sendUploadAck(sid, nil) }
