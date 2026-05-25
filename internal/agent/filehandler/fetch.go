package filehandler

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agent/vlog"
	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// fetchHTTP is overridable so unit tests can drive a httptest server.
var fetchHTTP = &http.Client{Timeout: 15 * time.Minute}

// HandleFetch is the agent side of agent-direct download. The server
// resolves the asset URL and (optionally) the expected sha256; the
// agent does the bytes-on-wire and extraction locally so the WS link
// stays free for control traffic. Replies through the FileUploadAck
// channel — success and failure shapes match Upload.
func (h *Handler) HandleFetch(ctx context.Context, req agentapi.FileFetch) {
	if err := h.sandboxCheck(req.Path, false); err != nil {
		h.sendUploadAck(req.Sid, err)
		return
	}
	mode := os.FileMode(req.Mode & 0o777)
	if mode == 0 {
		mode = 0o644
	}

	if dir := filepath.Dir(req.Path); dir != "" && dir != "/" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			h.sendUploadAck(req.Sid, err)
			return
		}
	}

	vlog.Debugf("fetch begin sid=%s url=%s path=%s extract=%v",
		req.Sid, req.URL, req.Path, req.Extract != nil)

	body, err := fetchDownload(ctx, req.URL)
	if err != nil {
		h.sendUploadAck(req.Sid, fmt.Errorf("download: %w", err))
		return
	}

	if req.SHA256 != "" {
		sum := sha256.Sum256(body)
		got := hex.EncodeToString(sum[:])
		if !strings.EqualFold(got, req.SHA256) {
			h.sendUploadAck(req.Sid, fmt.Errorf("sha256 mismatch: want %s got %s", req.SHA256, got))
			return
		}
	}

	payload := body
	if req.Extract != nil {
		extracted, err := fetchExtract(body, req.Extract)
		if err != nil {
			h.sendUploadAck(req.Sid, fmt.Errorf("extract: %w", err))
			return
		}
		payload = extracted
	}

	temp := req.Path + ".shep-fetching-" + req.Sid
	if err := os.WriteFile(temp, payload, 0o600); err != nil {
		h.sendUploadAck(req.Sid, err)
		return
	}
	if err := os.Chmod(temp, mode); err != nil {
		_ = os.Remove(temp)
		h.sendUploadAck(req.Sid, err)
		return
	}
	if err := os.Rename(temp, req.Path); err != nil {
		_ = os.Remove(temp)
		h.sendUploadAck(req.Sid, err)
		return
	}

	vlog.Debugf("fetch end sid=%s path=%s wrote=%d", req.Sid, req.Path, len(payload))
	h.sendUploadAckOK(req.Sid)
}

// fetchDownload GETs url and returns the full body. Stream-to-disk would
// be cheaper for huge files, but our binaries top out at ~60MB and the
// extract path needs the whole archive in memory anyway.
func fetchDownload(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := fetchHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

// fetchExtract pulls a single entry out of an archive. Kind selects the
// reader; EntryGlob is matched with filepath.Match against each entry's
// full archive-relative name. First match wins.
func fetchExtract(body []byte, e *agentapi.FetchExtract) ([]byte, error) {
	switch e.Kind {
	case "tar.gz":
		return extractTarGz(body, e.EntryGlob)
	case "zip":
		return extractZip(body, e.EntryGlob)
	default:
		return nil, fmt.Errorf("unknown extract kind %q", e.Kind)
	}
}

func extractTarGz(body []byte, glob string) ([]byte, error) {
	gzr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	defer func() { _ = gzr.Close() }()
	tr := tar.NewReader(gzr)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		ok, mErr := filepath.Match(glob, hdr.Name)
		if mErr != nil {
			return nil, fmt.Errorf("bad glob %q: %w", glob, mErr)
		}
		if !ok {
			continue
		}
		return io.ReadAll(tr)
	}
	return nil, fmt.Errorf("no entry matching %q in archive", glob)
}

func extractZip(body []byte, glob string) ([]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return nil, err
	}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		ok, mErr := filepath.Match(glob, f.Name)
		if mErr != nil {
			return nil, fmt.Errorf("bad glob %q: %w", glob, mErr)
		}
		if !ok {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer func() { _ = rc.Close() }()
		return io.ReadAll(rc)
	}
	return nil, fmt.Errorf("no entry matching %q in zip", glob)
}
