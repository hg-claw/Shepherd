package ptysvc

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type CastWriter struct {
	f         *os.File
	mu        sync.Mutex
	bytes     int64
	maxBytes  int64
	truncated bool
}

const defaultCastMaxBytes = 100 * 1024 * 1024

func NewCastWriter(path string, cols, rows int, started time.Time, command, title string) (*CastWriter, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return nil, err
	}
	hdr := map[string]any{
		"version":   2,
		"width":     cols,
		"height":    rows,
		"timestamp": started.Unix(),
		"command":   command,
	}
	if title != "" {
		hdr["title"] = title
	}
	b, _ := json.Marshal(hdr)
	if _, err := f.Write(append(b, '\n')); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &CastWriter{f: f, bytes: int64(len(b) + 1), maxBytes: defaultCastMaxBytes}, nil
}

func (w *CastWriter) SetMaxBytes(n int64) { w.maxBytes = n }
func (w *CastWriter) Truncated() bool     { w.mu.Lock(); defer w.mu.Unlock(); return w.truncated }

func (w *CastWriter) WriteOutput(elapsed time.Duration, p []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.truncated {
		return
	}
	str, _ := json.Marshal(string(p))
	line := append([]byte("["), []byte(strconv.FormatFloat(elapsed.Seconds(), 'f', 6, 64))...)
	line = append(line, ',', '"', 'o', '"', ',')
	line = append(line, str...)
	line = append(line, ']', '\n')
	if w.maxBytes > 0 && w.bytes+int64(len(line)) > w.maxBytes {
		w.truncated = true
		return
	}
	if _, err := w.f.Write(line); err == nil {
		w.bytes += int64(len(line))
	}
}

func (w *CastWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return nil
	}
	err := w.f.Close()
	w.f = nil
	return err
}
