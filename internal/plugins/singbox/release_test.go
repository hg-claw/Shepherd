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
	"strconv"
	"strings"
	"testing"
)

// makeTarGz builds a minimal shepherd-singbox tarball with the binary inside
// the same directory layout the build workflow produces:
// shepherd-singbox-vX.Y.Z-v2rayapi-{os}-{arch}/sing-box
func makeTarGz(t *testing.T, version, osName, arch string, binContent []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)

	dirName := fmt.Sprintf("shepherd-singbox-v%s-v2rayapi-%s-%s", version, osName, arch)
	_ = tw.WriteHeader(&tar.Header{
		Typeflag: tar.TypeDir,
		Name:     dirName + "/",
		Mode:     0755,
	})
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
	const version = "1.13.10"
	const osName = "linux"
	const arch = "amd64"

	fakeBin := []byte("#!/bin/sh\necho sing-box\n")
	tarBuf := makeTarGz(t, version, osName, arch, fakeBin)
	h256 := sha256.Sum256(tarBuf)
	wantSHA := hex.EncodeToString(h256[:])

	assetName := fmt.Sprintf("shepherd-singbox-v%s-v2rayapi-%s-%s.tar.gz", version, osName, arch)
	var hitCount int

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/example/repo/releases/tags/" + releaseTag(version):
			// Tag-direct endpoint — returns ONE release object, not a list.
			// Pre-fix the code iterated /releases (paged) and got starved
			// on busy repos; this proves we now hit the O(1) lookup.
			rel := map[string]any{
				"tag_name": releaseTag(version),
				"assets": []map[string]any{
					{
						"name":                 assetName,
						"browser_download_url": "http://" + r.Host + "/dl/" + assetName,
					},
				},
			}
			_ = json.NewEncoder(w).Encode(rel)
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
		Repo:     "example/repo",
		CacheDir: cacheDir,
		HTTP:     srv.Client(),
	}

	bin, err := rel.Fetch(context.Background(), version, osName, arch)
	if err != nil {
		t.Fatalf("Fetch: %v", err)
	}
	if bin.Version != version {
		t.Errorf("Version = %q want %q", bin.Version, version)
	}
	if bin.Sha256 != wantSHA {
		t.Errorf("Sha256 = %q want %q", bin.Sha256, wantSHA)
	}
	if hitCount != 1 {
		t.Errorf("download hit count = %d, want 1", hitCount)
	}

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

func TestReleaser_ListLatestTagsFiltersUnrelated(t *testing.T) {
	// Mimic GitHub's per-page semantics — page=1 returns the data,
	// page=2+ returns an empty array. The pagination loop relies on
	// the empty-array signal to terminate.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") != "1" {
			_ = json.NewEncoder(w).Encode([]map[string]any{})
			return
		}
		releases := []map[string]any{
			{"tag_name": "v0.7.6"},
			{"tag_name": "singbox-v1.13.10-v2rayapi"},
			{"tag_name": "v0.7.5"},
			{"tag_name": "singbox-v1.13.9-v2rayapi"},
			{"tag_name": "v0.7.4"},
		}
		_ = json.NewEncoder(w).Encode(releases)
	}))
	defer srv.Close()

	rel := &Releaser{BaseURL: srv.URL, Repo: "example/repo", HTTP: srv.Client()}
	got, err := rel.ListLatestTags(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"1.13.10", "1.13.9"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("ListLatestTags = %v, want %v", got, want)
	}
}

// Production regression: the singbox release was buried at position ~23
// in the /releases listing after ~10 intervening Shepherd vX.Y.Z tags.
// The old single-page fetch (per_page≈20) couldn't see it and returned
// []. This test sets up exactly that shape: 20 unrelated Shepherd tags
// on page 1, the actual singbox tag on page 2.
func TestReleaser_ListLatestTagsPaginatesPastUnrelatedTags(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		switch page {
		case "1":
			// 20 Shepherd server tags — none match the singbox filter
			releases := make([]map[string]any, 20)
			for i := range releases {
				releases[i] = map[string]any{"tag_name": "v0.7." + strconv.Itoa(i)}
			}
			_ = json.NewEncoder(w).Encode(releases)
		case "2":
			_ = json.NewEncoder(w).Encode([]map[string]any{
				{"tag_name": "singbox-v1.13.12-v2rayapi"},
			})
		default:
			_ = json.NewEncoder(w).Encode([]map[string]any{})
		}
	}))
	defer srv.Close()

	rel := &Releaser{BaseURL: srv.URL, Repo: "example/repo", HTTP: srv.Client()}
	got, err := rel.ListLatestTags(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got) != fmt.Sprint([]string{"1.13.12"}) {
		t.Errorf("ListLatestTags = %v, want [1.13.12] (must paginate past page-1 of non-matches)", got)
	}
}

func TestSingboxAssetName(t *testing.T) {
	cases := []struct {
		osName, arch, want string
	}{
		{"linux", "amd64", "shepherd-singbox-v1.13.10-v2rayapi-linux-amd64.tar.gz"},
		{"linux", "arm64", "shepherd-singbox-v1.13.10-v2rayapi-linux-arm64.tar.gz"},
		{"linux", "arm", "shepherd-singbox-v1.13.10-v2rayapi-linux-armv7.tar.gz"},
	}
	for _, c := range cases {
		got := singboxAssetName("1.13.10", c.osName, c.arch)
		if got != c.want {
			t.Errorf("singboxAssetName(1.13.10, %s, %s) = %q want %q", c.osName, c.arch, got, c.want)
		}
	}
}

func TestReleaser_MirrorPrefixWrapsDownloadURL(t *testing.T) {
	// When MirrorPrefix is set, the actual asset GET must hit
	// <prefix><real-github-url>. resolveAssetURL still hits the
	// api.github.com path unchanged (gh-proxy doesn't reliably mirror
	// API endpoints — that's the contract we documented on the field).
	const version = "1.13.12"
	fakeBin := []byte("BIN")
	tarBuf := makeTarGz(t, version, "linux", "amd64", fakeBin)
	assetName := singboxAssetName(version, "linux", "amd64")
	realDownloadURL := "https://github.com/example/repo/releases/download/" + releaseTag(version) + "/" + assetName

	var sawPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		switch {
		case r.URL.Path == "/repos/example/repo/releases/tags/"+releaseTag(version):
			rel := map[string]any{
				"tag_name": releaseTag(version),
				"assets": []map[string]any{
					{"name": assetName, "browser_download_url": realDownloadURL},
				},
			}
			_ = json.NewEncoder(w).Encode(rel)
		case strings.HasSuffix(r.URL.Path, realDownloadURL):
			// Mirror path: prefix path is "/<full-url>". httptest only
			// gives us the path; we just confirm the real URL is at the tail.
			_, _ = w.Write(tarBuf)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	rel := &Releaser{
		BaseURL:      srv.URL,
		Repo:         "example/repo",
		CacheDir:     t.TempDir(),
		HTTP:         srv.Client(),
		MirrorPrefix: srv.URL + "/",
	}
	bin, err := rel.Fetch(context.Background(), version, "linux", "amd64")
	if err != nil {
		t.Fatalf("Fetch: %v (saw path %q)", err, sawPath)
	}
	if bin.Path == "" {
		t.Fatal("empty bin path")
	}
	// Final hit was the mirror-wrapped URL; the path on the test server
	// will be "/<full-github-url>" — i.e. it ends with the realDownloadURL.
	if !strings.HasSuffix(sawPath, realDownloadURL) {
		t.Errorf("last request path %q does not end with %q", sawPath, realDownloadURL)
	}
}

func TestStripReleaseTag(t *testing.T) {
	cases := []struct{ in, want string }{
		{"singbox-v1.13.10-v2rayapi", "1.13.10"},
		{"singbox-v1.0.0-rc1-v2rayapi", "1.0.0-rc1"},
		{"v0.7.6", ""},
		{"singbox-v1.13.10", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := stripReleaseTag(c.in); got != c.want {
			t.Errorf("stripReleaseTag(%q) = %q want %q", c.in, got, c.want)
		}
	}
}
