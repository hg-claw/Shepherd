package filesvc

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

var ErrTimeout = errors.New("agent timeout")

type Hub interface {
	Send(serverID int64, env agentapi.Envelope) error
	SendBinary(serverID int64, sid string, kind byte, payload []byte) error
}

type Service struct {
	Hub        Hub
	Reg        *sessionmux.Registry
	ChunkBytes int
}

func (s *Service) chunkSize() int {
	if s.ChunkBytes > 0 {
		return s.ChunkBytes
	}
	return 256 * 1024
}

func (s *Service) request(ctx context.Context, serverID int64, frameType string, payload any, timeout time.Duration) (agentapi.Envelope, error) {
	sid := agentapi.NewSID()
	ch := s.Reg.RegisterRequest(sid)
	defer s.Reg.Unregister(sid)

	withSid := injectSid(payload, sid)
	env, err := agentapi.Frame(frameType, withSid)
	if err != nil {
		return agentapi.Envelope{}, err
	}
	if err := s.Hub.Send(serverID, env); err != nil {
		return agentapi.Envelope{}, err
	}

	select {
	case env, ok := <-ch:
		if !ok {
			return agentapi.Envelope{}, ErrTimeout
		}
		return env, nil
	case <-time.After(timeout):
		return agentapi.Envelope{}, ErrTimeout
	case <-ctx.Done():
		return agentapi.Envelope{}, ctx.Err()
	}
}

func (s *Service) List(ctx context.Context, serverID int64, path string, timeout time.Duration) ([]agentapi.FileEntry, error) {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	env, err := s.request(ctx, serverID, agentapi.TypeFileList, agentapi.FileList{Path: path}, timeout)
	if err != nil {
		return nil, err
	}
	var res agentapi.FileListResult
	_ = json.Unmarshal(env.P, &res)
	if res.Error != "" {
		return nil, errors.New(res.Error)
	}
	return res.Entries, nil
}

func (s *Service) Stat(ctx context.Context, serverID int64, path string) (agentapi.FileEntry, error) {
	env, err := s.request(ctx, serverID, agentapi.TypeFileStat, agentapi.FileStat{Path: path}, 10*time.Second)
	if err != nil {
		return agentapi.FileEntry{}, err
	}
	var res agentapi.FileStatResult
	_ = json.Unmarshal(env.P, &res)
	if res.Error != "" {
		return agentapi.FileEntry{}, errors.New(res.Error)
	}
	if res.Entry == nil {
		return agentapi.FileEntry{}, nil
	}
	return *res.Entry, nil
}

func (s *Service) Mkdir(ctx context.Context, serverID int64, path string, mode uint32) error {
	return s.opCall(ctx, serverID, agentapi.TypeFileMkdir, agentapi.FileMkdir{Path: path, Mode: mode}, 30*time.Second)
}
func (s *Service) Rename(ctx context.Context, serverID int64, src, dst string) error {
	return s.opCall(ctx, serverID, agentapi.TypeFileRename, agentapi.FileRename{Src: src, Dst: dst}, 30*time.Second)
}
func (s *Service) Rm(ctx context.Context, serverID int64, path string, recursive bool) error {
	return s.opCall(ctx, serverID, agentapi.TypeFileRm, agentapi.FileRm{Path: path, Recursive: recursive}, 30*time.Second)
}

func (s *Service) opCall(ctx context.Context, serverID int64, frameType string, payload any, timeout time.Duration) error {
	env, err := s.request(ctx, serverID, frameType, payload, timeout)
	if err != nil {
		return err
	}
	var res agentapi.FileOpResult
	_ = json.Unmarshal(env.P, &res)
	if !res.OK {
		return errors.New(res.Error)
	}
	return nil
}

type uploadAdapter struct {
	sid string
	got chan agentapi.FileUploadAck
	mu  sync.Mutex
}

func (u *uploadAdapter) DeliverBinary(_ []byte) {}
func (u *uploadAdapter) DeliverControl(env agentapi.Envelope) {
	if env.Type != agentapi.TypeFileUploadAck {
		return
	}
	var ack agentapi.FileUploadAck
	_ = json.Unmarshal(env.P, &ack)
	select {
	case u.got <- ack:
	default:
	}
}

func (s *Service) Upload(ctx context.Context, serverID int64, path string, mode uint32, size int64, sha256hex string, body io.Reader) error {
	sid := agentapi.NewSID()
	a := &uploadAdapter{sid: sid, got: make(chan agentapi.FileUploadAck, 1)}
	s.Reg.RegisterFile(sid, a)
	defer s.Reg.Unregister(sid)

	begin, _ := agentapi.Frame(agentapi.TypeFileUploadBegin, agentapi.FileUploadBegin{
		Sid: sid, Path: path, Size: size, Mode: mode, SHA256: sha256hex,
	})
	if err := s.Hub.Send(serverID, begin); err != nil {
		return err
	}

	buf := make([]byte, s.chunkSize())
	for {
		n, err := body.Read(buf)
		if n > 0 {
			if sErr := s.Hub.SendBinary(serverID, sid, agentapi.KindFileChunk, buf[:n]); sErr != nil {
				return sErr
			}
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
	}
	end, _ := agentapi.Frame(agentapi.TypeFileUploadEnd, agentapi.FileUploadEnd{Sid: sid, TotalBytes: size, SHA256: sha256hex})
	if err := s.Hub.Send(serverID, end); err != nil {
		return err
	}
	select {
	case ack := <-a.got:
		if !ack.OK {
			return errors.New(ack.Error)
		}
		return nil
	case <-time.After(60 * time.Second):
		return ErrTimeout
	}
}

type downloadAdapter struct {
	w      io.Writer
	metaCh chan agentapi.FileDownloadMeta
	doneCh chan error
}

func (d *downloadAdapter) DeliverBinary(p []byte) { _, _ = d.w.Write(p) }
func (d *downloadAdapter) DeliverControl(env agentapi.Envelope) {
	switch env.Type {
	case agentapi.TypeFileDownloadMeta:
		var m agentapi.FileDownloadMeta
		_ = json.Unmarshal(env.P, &m)
		select {
		case d.metaCh <- m:
		default:
		}
	case agentapi.TypeFileDownloadEnd:
		select {
		case d.doneCh <- nil:
		default:
		}
	case agentapi.TypeFileCancel:
		var c agentapi.FileCancel
		_ = json.Unmarshal(env.P, &c)
		select {
		case d.doneCh <- errors.New(c.Reason):
		default:
		}
	}
}

func (s *Service) Download(ctx context.Context, serverID int64, path string, w io.Writer) (agentapi.FileDownloadMeta, error) {
	sid := agentapi.NewSID()
	a := &downloadAdapter{w: w, metaCh: make(chan agentapi.FileDownloadMeta, 1), doneCh: make(chan error, 1)}
	s.Reg.RegisterFile(sid, a)
	defer s.Reg.Unregister(sid)
	env, _ := agentapi.Frame(agentapi.TypeFileDownloadBegin, agentapi.FileDownloadBegin{Sid: sid, Path: path})
	if err := s.Hub.Send(serverID, env); err != nil {
		return agentapi.FileDownloadMeta{}, err
	}
	var meta agentapi.FileDownloadMeta
	select {
	case meta = <-a.metaCh:
		if meta.Error != "" {
			return meta, errors.New(meta.Error)
		}
	case <-time.After(30 * time.Second):
		return meta, ErrTimeout
	}
	select {
	case err := <-a.doneCh:
		return meta, err
	case <-ctx.Done():
		cancel, _ := agentapi.Frame(agentapi.TypeFileCancel, agentapi.FileCancel{Sid: sid, Reason: "client cancel"})
		_ = s.Hub.Send(serverID, cancel)
		return meta, ctx.Err()
	}
}

func injectSid(payload any, sid string) any {
	b, _ := json.Marshal(payload)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	if m == nil {
		m = map[string]any{}
	}
	m["sid"] = sid
	return m
}
