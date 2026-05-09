package filehandler

import (
	"errors"
	"io"
	"os"
	"sync/atomic"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type downloadXfer struct {
	cancel atomic.Bool
}

const downloadChunk = 256 * 1024

func (h *Handler) HandleDownloadBegin(req agentapi.FileDownloadBegin) {
	if err := h.sandboxCheck(req.Path, true); err != nil {
		h.sendDownloadMeta(req.Sid, agentapi.FileDownloadMeta{Sid: req.Sid, Error: err.Error()})
		return
	}
	info, err := os.Stat(req.Path)
	if err != nil {
		h.sendDownloadMeta(req.Sid, agentapi.FileDownloadMeta{Sid: req.Sid, Error: err.Error()})
		return
	}
	if info.IsDir() {
		h.sendDownloadMeta(req.Sid, agentapi.FileDownloadMeta{Sid: req.Sid, Error: "is a directory"})
		return
	}
	f, err := os.Open(req.Path)
	if err != nil {
		h.sendDownloadMeta(req.Sid, agentapi.FileDownloadMeta{Sid: req.Sid, Error: err.Error()})
		return
	}
	xfer := &downloadXfer{}
	h.transfers.Store(req.Sid, xfer)
	h.sendDownloadMeta(req.Sid, agentapi.FileDownloadMeta{
		Sid: req.Sid, Size: info.Size(),
		Mode: uint32(info.Mode()), MTime: info.ModTime().Unix(),
	})
	go h.streamDownload(req.Sid, f, xfer)
}

func (h *Handler) streamDownload(sid string, f *os.File, x *downloadXfer) {
	defer func() { _ = f.Close() }()
	defer h.transfers.Delete(sid)
	buf := make([]byte, downloadChunk)
	for {
		if x.cancel.Load() {
			return
		}
		n, err := f.Read(buf)
		if n > 0 {
			if sendErr := h.sender.SendBinary(sid, agentapi.KindFileChunk, buf[:n]); sendErr != nil {
				return
			}
		}
		if errors.Is(err, io.EOF) {
			env, _ := agentapi.FrameSid(agentapi.TypeFileDownloadEnd, sid, agentapi.FileDownloadEnd{Sid: sid})
			_ = h.sender.SendControl(env)
			return
		}
		if err != nil {
			env, _ := agentapi.FrameSid(agentapi.TypeFileCancel, sid, agentapi.FileCancel{Sid: sid, Reason: err.Error()})
			_ = h.sender.SendControl(env)
			return
		}
	}
}

func (h *Handler) HandleCancel(req agentapi.FileCancel) {
	v, ok := h.transfers.LoadAndDelete(req.Sid)
	if !ok {
		return
	}
	switch x := v.(type) {
	case *downloadXfer:
		x.cancel.Store(true)
	case *uploadXfer:
		_ = x.f.Close()
		_ = os.Remove(x.temp)
	}
}

func (h *Handler) sendDownloadMeta(_ string, meta agentapi.FileDownloadMeta) {
	env, _ := agentapi.FrameSid(agentapi.TypeFileDownloadMeta, meta.Sid, meta)
	_ = h.sender.SendControl(env)
}
