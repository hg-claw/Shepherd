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
	mux.HandleFunc("/releases/download/v1.2.3/Xray-linux-amd64.zip", func(w http.ResponseWriter, r *http.Request) {
		w.Write(zipBytes)
	})
	mux.HandleFunc("/releases/download/v1.2.3/Xray-linux-amd64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "SHA2-256= "+dgstHex+"\n")
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
		io.WriteString(w, `[
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

func TestFetchShaMismatch(t *testing.T) {
	zipBytes := makeZip(t, "xray", "X")
	mux := http.NewServeMux()
	mux.HandleFunc("/releases/download/v9.9.9/Xray-linux-amd64.zip", func(w http.ResponseWriter, r *http.Request) {
		w.Write(zipBytes)
	})
	mux.HandleFunc("/releases/download/v9.9.9/Xray-linux-amd64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, "SHA2-256= 0000000000000000000000000000000000000000000000000000000000000000\n")
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
