package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/audit"
	"github.com/hg-claw/Shepherd/internal/auth"
	"github.com/hg-claw/Shepherd/internal/filesvc"
)

type FilesAPI struct {
	Files     *filesvc.Service
	Audit     *audit.Writer
	MaxUpload int64
}

func (a *FilesAPI) maxUpload() int64 {
	if a.MaxUpload > 0 {
		return a.MaxUpload
	}
	return 100 * 1024 * 1024
}

func (a *FilesAPI) List(w http.ResponseWriter, r *http.Request) {
	sid, _ := strconv.ParseInt(r.URL.Query().Get("server_id"), 10, 64)
	path := r.URL.Query().Get("path")
	out, err := a.Files.List(r.Context(), sid, path, 10*time.Second)
	if err != nil {
		writeFilesErr(w, err)
		return
	}
	writeJSON(w, 200, out)
}

type filePathReq struct {
	ServerID  int64  `json:"server_id"`
	Path      string `json:"path"`
	Mode      uint32 `json:"mode,omitempty"`
	Recursive bool   `json:"recursive,omitempty"`
	Src       string `json:"src,omitempty"`
	Dst       string `json:"dst,omitempty"`
}

func (a *FilesAPI) Mkdir(w http.ResponseWriter, r *http.Request) {
	var req filePathReq
	_ = decodeJSON(r, &req)
	if err := a.Files.Mkdir(r.Context(), req.ServerID, req.Path, req.Mode); err != nil {
		writeFilesErr(w, err)
		return
	}
	a.audit(r, "file.mkdir", req.ServerID, map[string]any{"path": req.Path}, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *FilesAPI) Rename(w http.ResponseWriter, r *http.Request) {
	var req filePathReq
	_ = decodeJSON(r, &req)
	if err := a.Files.Rename(r.Context(), req.ServerID, req.Src, req.Dst); err != nil {
		writeFilesErr(w, err)
		return
	}
	a.audit(r, "file.rename", req.ServerID, map[string]any{"src": req.Src, "dst": req.Dst}, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *FilesAPI) Rm(w http.ResponseWriter, r *http.Request) {
	var req filePathReq
	_ = decodeJSON(r, &req)
	if err := a.Files.Rm(r.Context(), req.ServerID, req.Path, req.Recursive); err != nil {
		writeFilesErr(w, err)
		return
	}
	a.audit(r, "file.rm", req.ServerID, map[string]any{"path": req.Path, "recursive": req.Recursive}, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *FilesAPI) Stat(w http.ResponseWriter, r *http.Request) {
	var req filePathReq
	_ = decodeJSON(r, &req)
	ent, err := a.Files.Stat(r.Context(), req.ServerID, req.Path)
	if err != nil {
		writeFilesErr(w, err)
		return
	}
	writeJSON(w, 200, ent)
}

// previewRead pipes downloadFn's output and returns up to maxB bytes. On return
// it cancels the download context (so Download sends FileCancel and the agent
// stops streaming) and closes the pipe reader (so an in-flight write fails fast
// instead of head-of-line-blocking the agent connection's read loop).
func previewRead(ctx context.Context, maxB int, downloadFn func(context.Context, io.Writer) error) []byte {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	defer func() { _ = pr.Close() }()
	go func() { _ = pw.CloseWithError(downloadFn(ctx, pw)) }()
	buf := make([]byte, maxB)
	n, _ := io.ReadFull(pr, buf)
	return buf[:n]
}

func (a *FilesAPI) Preview(w http.ResponseWriter, r *http.Request) {
	sid, _ := strconv.ParseInt(r.URL.Query().Get("server_id"), 10, 64)
	path := r.URL.Query().Get("path")
	maxB, _ := strconv.Atoi(r.URL.Query().Get("max_bytes"))
	if maxB <= 0 || maxB > 256*1024 {
		maxB = 64 * 1024
	}
	data := previewRead(r.Context(), maxB, func(ctx context.Context, dst io.Writer) error {
		_, err := a.Files.Download(ctx, sid, path, dst)
		return err
	})
	for _, b := range data {
		if b == 0 {
			writeError(w, 415, "binary content")
			return
		}
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(200)
	_, _ = w.Write(data)
}

func (a *FilesAPI) Download(w http.ResponseWriter, r *http.Request) {
	sid, _ := strconv.ParseInt(r.URL.Query().Get("server_id"), 10, 64)
	path := r.URL.Query().Get("path")
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+escapeFilename(path)+`"`)
	meta, err := a.Files.Download(r.Context(), sid, path, w)
	if err != nil {
		return
	}
	a.audit(r, "file.download", sid, map[string]any{"path": path, "size": meta.Size}, nil)
}

func (a *FilesAPI) Upload(w http.ResponseWriter, r *http.Request) {
	sid, _ := strconv.ParseInt(r.URL.Query().Get("server_id"), 10, 64)
	path := r.URL.Query().Get("path")
	mode64, _ := strconv.ParseUint(r.URL.Query().Get("mode"), 10, 32)
	r.Body = http.MaxBytesReader(w, r.Body, a.maxUpload())
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeError(w, 413, err.Error())
		return
	}
	sum := sha256.Sum256(body)
	if err := a.Files.Upload(r.Context(), sid, path, uint32(mode64), int64(len(body)), hex.EncodeToString(sum[:]), readerFromBytes(body)); err != nil {
		if errors.Is(err, agentsvc.ErrAgentOffline) {
			writeError(w, 503, err.Error())
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	a.audit(r, "file.upload", sid, map[string]any{"path": path, "size": len(body)}, nil)
	writeJSON(w, 200, map[string]any{"ok": true})
}

func (a *FilesAPI) audit(r *http.Request, action string, serverID int64, det map[string]any, errResult error) {
	if a.Audit == nil {
		return
	}
	admin, _ := auth.AdminFromContext(r.Context())
	var adminID *int64
	if admin != nil {
		adminID = &admin.ID
	}
	a.Audit.Write(r.Context(), adminID, &serverID, action, det, errResult)
}

func writeFilesErr(w http.ResponseWriter, err error) {
	if errors.Is(err, agentsvc.ErrAgentOffline) {
		writeError(w, 503, err.Error())
		return
	}
	if strings.HasPrefix(err.Error(), "path not allowed") {
		writeError(w, 403, err.Error())
		return
	}
	writeError(w, 500, err.Error())
}

func readerFromBytes(b []byte) io.Reader { return &byteReader{b: b} }

type byteReader struct {
	b []byte
	i int
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, io.EOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}

func escapeFilename(p string) string {
	out := make([]byte, 0, len(p))
	for i := 0; i < len(p); i++ {
		c := p[i]
		if c == '"' || c == '\\' {
			out = append(out, '\\')
		}
		out = append(out, c)
	}
	return string(out)
}
