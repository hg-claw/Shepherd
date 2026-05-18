package xray

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func makeZip(t *testing.T, name, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create(name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestFetchAndCache(t *testing.T) {
	zipBytes := makeZip(t, "xray", "BIN-CONTENT")
	dgst := sha256.Sum256(zipBytes)
	dgstHex := hex.EncodeToString(dgst[:])

	mux := http.NewServeMux()
	mux.HandleFunc("/releases/download/v1.2.3/Xray-linux-64.zip", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(zipBytes)
	})
	mux.HandleFunc("/releases/download/v1.2.3/Xray-linux-64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "SHA2-256= "+dgstHex+"\n")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r := &Releaser{
		BaseURL:  srv.URL,
		CacheDir: t.TempDir(),
	}
	bin, err := r.Fetch(context.Background(), "1.2.3", "linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if bin.Version != "1.2.3" || bin.Sha256 != dgstHex {
		t.Fatalf("unexpected binary metadata: %+v", bin)
	}
	got, err := os.ReadFile(bin.Path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "BIN-CONTENT" {
		t.Fatalf("extracted binary content = %q", got)
	}

	cached := bin.Path
	bin2, err := r.Fetch(context.Background(), "1.2.3", "linux", "amd64")
	if err != nil {
		t.Fatal(err)
	}
	if bin2.Path != cached {
		t.Fatalf("expected cache hit, paths differ: %s vs %s", cached, bin2.Path)
	}
}

func TestListLatestTags(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/XTLS/Xray-core/releases", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `[
			{"tag_name":"v1.8.11"},
			{"tag_name":"v1.8.10"},
			{"tag_name":"v1.8.9"}
		]`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := &Releaser{BaseURL: srv.URL}
	tags, err := r.ListLatestTags(context.Background(), 3)
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 3 || tags[0] != "1.8.11" {
		t.Fatalf("got %v", tags)
	}
}

func TestXrayAssetAliases(t *testing.T) {
	cases := []struct{ inOS, inArch, wantOS, wantArch string }{
		{"linux", "amd64", "linux", "64"},
		{"linux", "arm64", "linux", "arm64-v8a"},
		{"linux", "arm", "linux", "arm32-v7a"},
		{"darwin", "amd64", "macos", "64"},
		{"darwin", "arm64", "macos", "arm64-v8a"},
		{"windows", "386", "windows", "32"},
		{"linux", "riscv64", "linux", "riscv64"},
	}
	for _, c := range cases {
		if got := xrayOS(c.inOS); got != c.wantOS {
			t.Errorf("xrayOS(%s) = %s want %s", c.inOS, got, c.wantOS)
		}
		if got := xrayArch(c.inArch); got != c.wantArch {
			t.Errorf("xrayArch(%s) = %s want %s", c.inArch, got, c.wantArch)
		}
	}
}

func TestFetchPicksSHA256FromMultilineDgst(t *testing.T) {
	zipBytes := makeZip(t, "xray", "BIN")
	dgst := sha256.Sum256(zipBytes)
	want := hex.EncodeToString(dgst[:])

	// Real xray .dgst body: MD5, SHA1, SHA2-256, SHA2-512 — four lines.
	// The previous parser grabbed the LAST space-separated token in the whole
	// body, which was the SHA2-512 hex. This test would have failed under that
	// implementation.
	body := "MD5= 00000000000000000000000000000000\n" +
		"SHA1= 0000000000000000000000000000000000000000\n" +
		"SHA2-256= " + want + "\n" +
		"SHA2-512= 0000000000000000000000000000000000000000000000000000000000000000" +
		"0000000000000000000000000000000000000000000000000000000000000000\n"

	mux := http.NewServeMux()
	mux.HandleFunc("/releases/download/v1.0.0/Xray-linux-64.zip", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(zipBytes)
	})
	mux.HandleFunc("/releases/download/v1.0.0/Xray-linux-64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, body)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := &Releaser{BaseURL: srv.URL, CacheDir: t.TempDir()}
	bin, err := r.Fetch(context.Background(), "1.0.0", "linux", "amd64")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if bin.Sha256 != want {
		t.Fatalf("Sha256 = %s want %s", bin.Sha256, want)
	}
}

func TestFetchShaMismatch(t *testing.T) {
	zipBytes := makeZip(t, "xray", "X")
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/download/v9.9.9/Xray-linux-64.zip", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(zipBytes)
	})
	mux.HandleFunc("/releases/download/v9.9.9/Xray-linux-64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "SHA2-256= 0000000000000000000000000000000000000000000000000000000000000000\n")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	r := &Releaser{BaseURL: srv.URL, CacheDir: t.TempDir()}
	_, err := r.Fetch(context.Background(), "9.9.9", "linux", "amd64")
	if err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("expected sha256 error, got %v", err)
	}
	files, _ := filepath.Glob(r.CacheDir + "/*")
	if len(files) != 0 {
		t.Fatalf("cache should be empty on failure: %v", files)
	}
}
