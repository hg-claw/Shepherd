package filehandler

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// fetchAckSender captures the ack the handler emits so each test can
// assert OK/error without going through the WS stack.
type fetchAckSender struct {
	mu  sync.Mutex
	acks []agentapi.FileUploadAck
}

func (r *fetchAckSender) SendControl(env agentapi.Envelope) error {
	if env.Type != agentapi.TypeFileUploadAck {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	var ack agentapi.FileUploadAck
	_ = env.Decode(&ack)
	r.acks = append(r.acks, ack)
	return nil
}
func (r *fetchAckSender) SendBinary(string, byte, []byte) error { return nil }

func (r *fetchAckSender) lastAck(t *testing.T) agentapi.FileUploadAck {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.acks) == 0 {
		t.Fatal("no ack received")
	}
	return r.acks[len(r.acks)-1]
}

func makeFetchHandler(t *testing.T) (*Handler, *fetchAckSender) {
	t.Helper()
	s := &fetchAckSender{}
	h := New(s)
	// Disable sandbox so writes to t.TempDir() pass — tests pick paths
	// inside TempDir which isn't on the default allowlist.
	h.SetSandbox(&Sandbox{Enabled: false})
	return h, s
}

func TestHandleFetch_PlainBody(t *testing.T) {
	body := []byte("HELLO FETCHED BINARY")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	h, s := makeFetchHandler(t)
	dest := filepath.Join(t.TempDir(), "out.bin")
	h.HandleFetch(context.Background(), agentapi.FileFetch{
		Sid:  "sid1",
		URL:  srv.URL + "/foo",
		Path: dest,
		Mode: 0o755,
	})
	ack := s.lastAck(t)
	if !ack.OK {
		t.Fatalf("expected OK ack, got error: %s", ack.Error)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, body) {
		t.Errorf("installed bytes mismatch: %q vs %q", got, body)
	}
	st, _ := os.Stat(dest)
	if st.Mode().Perm() != 0o755 {
		t.Errorf("Mode = %o, want 0755", st.Mode().Perm())
	}
}

func TestHandleFetch_SHA256VerifyMismatch(t *testing.T) {
	body := []byte("CONTENT")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	h, s := makeFetchHandler(t)
	dest := filepath.Join(t.TempDir(), "out.bin")
	h.HandleFetch(context.Background(), agentapi.FileFetch{
		Sid:  "sid2",
		URL:  srv.URL + "/foo",
		Path: dest,
		Mode: 0o755,
		// Wrong SHA — handler must reject and NOT install.
		SHA256: "0000000000000000000000000000000000000000000000000000000000000000",
	})
	ack := s.lastAck(t)
	if ack.OK {
		t.Fatal("expected error ack, got OK")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Errorf("dest file should not exist after sha mismatch; err=%v", err)
	}
}

func TestHandleFetch_TarGzExtract(t *testing.T) {
	// Build a minimal tar.gz with a nested directory layout matching
	// the shepherd-singbox release format.
	innerBin := []byte("SINGBOX-BINARY")
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	_ = tw.WriteHeader(&tar.Header{Name: "shepherd-singbox-v1/sing-box", Mode: 0o755, Size: int64(len(innerBin))})
	_, _ = tw.Write(innerBin)
	_ = tw.Close()
	_ = gw.Close()
	body := buf.Bytes()
	sum := sha256.Sum256(body)
	wantSHA := hex.EncodeToString(sum[:])

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	h, s := makeFetchHandler(t)
	dest := filepath.Join(t.TempDir(), "sing-box")
	h.HandleFetch(context.Background(), agentapi.FileFetch{
		Sid: "sid3", URL: srv.URL, Path: dest, Mode: 0o755, SHA256: wantSHA,
		Extract: &agentapi.FetchExtract{Kind: "tar.gz", EntryGlob: "*/sing-box"},
	})
	ack := s.lastAck(t)
	if !ack.OK {
		t.Fatalf("expected OK, got: %s", ack.Error)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, innerBin) {
		t.Errorf("extracted bytes mismatch: %q vs %q", got, innerBin)
	}
}

func TestHandleFetch_ZipExtract(t *testing.T) {
	innerBin := []byte("XRAY-BINARY")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("xray")
	_, _ = w.Write(innerBin)
	_ = zw.Close()
	body := buf.Bytes()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer srv.Close()

	h, s := makeFetchHandler(t)
	dest := filepath.Join(t.TempDir(), "xray")
	h.HandleFetch(context.Background(), agentapi.FileFetch{
		Sid: "sid4", URL: srv.URL, Path: dest, Mode: 0o755,
		Extract: &agentapi.FetchExtract{Kind: "zip", EntryGlob: "xray"},
	})
	ack := s.lastAck(t)
	if !ack.OK {
		t.Fatalf("expected OK, got: %s", ack.Error)
	}
	got, _ := os.ReadFile(dest)
	if !bytes.Equal(got, innerBin) {
		t.Errorf("extracted = %q, want %q", got, innerBin)
	}
}

func TestHandleFetch_UnknownExtractKind(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("x"))
	}))
	defer srv.Close()

	h, s := makeFetchHandler(t)
	h.HandleFetch(context.Background(), agentapi.FileFetch{
		Sid: "sid5", URL: srv.URL, Path: filepath.Join(t.TempDir(), "x"),
		Extract: &agentapi.FetchExtract{Kind: "rar", EntryGlob: "*"},
	})
	ack := s.lastAck(t)
	if ack.OK {
		t.Fatal("expected error for unknown kind")
	}
}

func TestHandleFetch_HTTPNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", 500)
	}))
	defer srv.Close()

	h, s := makeFetchHandler(t)
	h.HandleFetch(context.Background(), agentapi.FileFetch{
		Sid: "sid6", URL: srv.URL, Path: filepath.Join(t.TempDir(), "out"),
	})
	ack := s.lastAck(t)
	if ack.OK {
		t.Fatal("expected error ack for HTTP 500")
	}
}
