package filehandler

import (
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type Sender interface {
	SendControl(env agentapi.Envelope) error
	SendBinary(sid string, kind byte, payload []byte) error
}

type Handler struct {
	sender    Sender
	sandbox   atomic.Pointer[Sandbox]
	transfers sync.Map // sid → *xfer (filled in by upload/download tasks)
}

func New(sender Sender) *Handler {
	h := &Handler{sender: sender}
	h.sandbox.Store(&Sandbox{Enabled: false})
	return h
}

func (h *Handler) SetSandbox(s *Sandbox) { h.sandbox.Store(s) }

func (h *Handler) sandboxCheck(p string, mustExist bool) error {
	return h.sandbox.Load().Check(p, mustExist)
}

func (h *Handler) sendOpResult(sid string, err error) {
	res := agentapi.FileOpResult{Sid: sid, OK: err == nil}
	if err != nil {
		res.Error = err.Error()
	}
	env, _ := agentapi.FrameSid(agentapi.TypeFileOpResult, sid, res)
	_ = h.sender.SendControl(env)
}

func (h *Handler) HandleList(req agentapi.FileList) {
	res := agentapi.FileListResult{Sid: req.Sid}
	if err := h.sandboxCheck(req.Path, true); err != nil {
		res.Error = err.Error()
	} else {
		ents, err := os.ReadDir(req.Path)
		if err != nil {
			res.Error = err.Error()
		} else {
			for _, e := range ents {
				info, lerr := os.Lstat(filepath.Join(req.Path, e.Name()))
				if lerr != nil {
					continue
				}
				fe := agentapi.FileEntry{
					Name: e.Name(), Size: info.Size(), Mode: uint32(info.Mode()),
					MTime: info.ModTime().Unix(), IsDir: info.IsDir(),
				}
				if info.Mode()&os.ModeSymlink != 0 {
					fe.IsLink = true
					if tgt, terr := os.Readlink(filepath.Join(req.Path, e.Name())); terr == nil {
						fe.LinkTarget = tgt
					}
				}
				res.Entries = append(res.Entries, fe)
			}
		}
	}
	env, _ := agentapi.FrameSid(agentapi.TypeFileListResult, req.Sid, res)
	_ = h.sender.SendControl(env)
}

func (h *Handler) HandleStat(req agentapi.FileStat) {
	res := agentapi.FileStatResult{Sid: req.Sid}
	if err := h.sandboxCheck(req.Path, true); err != nil {
		res.Error = err.Error()
	} else if info, err := os.Lstat(req.Path); err != nil {
		res.Error = err.Error()
	} else {
		res.Entry = &agentapi.FileEntry{
			Name: filepath.Base(req.Path), Size: info.Size(),
			Mode: uint32(info.Mode()), MTime: info.ModTime().Unix(), IsDir: info.IsDir(),
		}
	}
	env, _ := agentapi.FrameSid(agentapi.TypeFileStatResult, req.Sid, res)
	_ = h.sender.SendControl(env)
}

func (h *Handler) HandleMkdir(req agentapi.FileMkdir) {
	mode := os.FileMode(req.Mode & 0o777)
	if mode == 0 {
		mode = 0o755
	}
	err := h.sandboxCheck(req.Path, false)
	if err == nil {
		err = os.MkdirAll(req.Path, mode)
	}
	h.sendOpResult(req.Sid, err)
}

func (h *Handler) HandleRename(req agentapi.FileRename) {
	err := h.sandboxCheck(req.Src, true)
	if err == nil {
		err = h.sandboxCheck(req.Dst, false)
	}
	if err == nil {
		err = os.Rename(req.Src, req.Dst)
	}
	h.sendOpResult(req.Sid, err)
}

func (h *Handler) HandleRm(req agentapi.FileRm) {
	err := h.sandboxCheck(req.Path, true)
	if err == nil {
		if req.Recursive {
			err = os.RemoveAll(req.Path)
		} else {
			err = os.Remove(req.Path)
		}
	}
	h.sendOpResult(req.Sid, err)
}
