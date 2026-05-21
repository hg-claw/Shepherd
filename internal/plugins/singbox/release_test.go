package singbox

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// makeTarGz builds a minimal sing-box tarball with the binary inside a versioned directory.
func makeTarGz(t *testing.T, version, osName, arch string, binContent []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	dirName := fmt.Sprintf("sing-box-%s-%s-%s", version, osName, arch)
	// Write a directory entry
	_ = tw.WriteHeader(&tar.Header{
		Typeflag: tar.TypeDir,
		Name:     dirName + "/",
		Mode:     0755,
	})
	// Write the binary inside the versioned directory
	_ = tw.WriteHeader(&tar.Header{
		Name: dirName + "/sing-box",
		Mode: 0755,
		Size: int64(len(binContent)),
	})
	_, _ = tw.Write(binContent)
	_ = tw.Close()
	_ = gw.Close()
	return buf.Bytes()
}

func TestReleaser_FetchAndCacheHit(t *testing.T) {
	const version = "1.11.5"
	const osName = "linux"
	const arch = "amd64"

	fakeBin := []byte("#!/bin/sh\necho sing-box\n")
	tarBuf := makeTarGz(t, version, osName, arch, fakeBin)
	h256 := sha256.Sum256(tarBuf)
	wantSHA := hex.EncodeToString(h256[:])

	assetName := fmt.Sprintf("sing-box-%s-%s-%s.tar.gz", version, osName, arch)
	var hitCount int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/SagerNet/sing-box/releases":
			releases := []map[string]any{{
				"tag_name": "v" + version,
				"assets": []map[string]any{
					{
						"name":                 assetName,
						"browser_download_url": "http://" + r.Host + "/dl/" + assetName,
					},
				},
			}}
			_ = json.NewEncoder(w).Encode(releases)
		case "/dl/" + assetName:
			hitCount++
			w.Header().Set("Content-Length", fmt.Sprint(len(tarBuf)))
			_, _ = w.Write(tarBuf)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cacheDir := t.TempDir()
	rel := &Releaser{
		BaseURL:  srv.URL,
		CacheDir: cacheDir,
		HTTP:     srv.Client(),
	}

	// First fetch: should download and extract.
	bin, err := rel.Fetch(context.Background(), version, osName, arch)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if bin.Version != version {
		t.Errorf("Version = %q want %q", bin.Version, version)
	}
	if bin.OS != osName {
		t.Errorf("OS = %q want %q", bin.OS, osName)
	}
	if bin.Arch != arch {
		t.Errorf("Arch = %q want %q", bin.Arch, arch)
	}
	if bin.Sha256 != wantSHA {
		t.Errorf("Sha256 = %q want %q", bin.Sha256, wantSHA)
	}
	if bin.Path == "" {
		t.Fatal("Path is empty")
	}
	if hitCount != 1 {
		t.Errorf("download hit count = %d, want 1", hitCount)
	}

	// Second fetch: cache hit, no second HTTP download.
	bin2, err := rel.Fetch(context.Background(), version, osName, arch)
	if err != nil {
		t.Fatalf("cache hit Fetch: %v", err)
	}
	if bin2.Path != bin.Path {
		t.Errorf("cache hit returned different path: %s vs %s", bin2.Path, bin.Path)
	}
	if hitCount != 1 {
		t.Errorf("download hit count after cache = %d, want still 1", hitCount)
	}
}

func TestSingboxAssetName(t *testing.T) {
	cases := []struct {
		osName, arch, want string
	}{
		{"linux", "amd64", "sing-box-1.10.0-linux-amd64.tar.gz"},
		{"linux", "arm64", "sing-box-1.10.0-linux-arm64.tar.gz"},
		{"linux", "arm", "sing-box-1.10.0-linux-armv7.tar.gz"},
		{"linux", "386", "sing-box-1.10.0-linux-386.tar.gz"},
		{"darwin", "amd64", "sing-box-1.10.0-darwin-amd64.tar.gz"},
		{"darwin", "arm64", "sing-box-1.10.0-darwin-arm64.tar.gz"},
		{"windows", "amd64", "sing-box-1.10.0-windows-amd64.tar.gz"},
		{"windows", "386", "sing-box-1.10.0-windows-386.tar.gz"},
	}
	for _, c := range cases {
		got := singboxAssetName("1.10.0", c.osName, c.arch)
		if got != c.want {
			t.Errorf("singboxAssetName(1.10.0, %s, %s) = %q want %q", c.osName, c.arch, got, c.want)
		}
	}
}
