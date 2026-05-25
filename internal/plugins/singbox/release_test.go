package singbox

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// TestReleaser_ResolveFetchSpec_Direct verifies the spec built when the
// operator does NOT request the CN mirror — both the API call and the
// sidecar GET hit github.com (here, our httptest server). The sidecar
// is served with a real sha256sum-format response so SHA gets populated.
func TestReleaser_ResolveFetchSpec_Direct(t *testing.T) {
	const version = "1.13.10"
	const osName = "linux"
	const arch = "amd64"
	assetName := fmt.Sprintf("shepherd-singbox-v%s-v2rayapi-%s-%s.tar.gz", version, osName, arch)
	const wantSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

	var dlURL string // captured from server-side base
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/repos/example/repo/releases/tags/"+releaseTag(version):
			rel := map[string]any{
				"tag_name": releaseTag(version),
				"assets": []map[string]any{
					{"name": assetName, "browser_download_url": dlURL},
				},
			}
			_ = json.NewEncoder(w).Encode(rel)
		case strings.HasSuffix(r.URL.Path, ".sha256"):
			_, _ = fmt.Fprintf(w, "%s  %s\n", wantSHA, assetName)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	dlURL = srv.URL + "/releases/download/" + releaseTag(version) + "/" + assetName

	rel := &Releaser{BaseURL: srv.URL, Repo: "example/repo", HTTP: srv.Client()}
	spec, err := rel.ResolveFetchSpec(context.Background(), version, osName, arch, false)
	if err != nil {
		t.Fatalf("ResolveFetchSpec: %v", err)
	}
	if spec.URL != dlURL {
		t.Errorf("URL = %q, want %q", spec.URL, dlURL)
	}
	if spec.SHA256 != wantSHA {
		t.Errorf("SHA256 = %q, want %q", spec.SHA256, wantSHA)
	}
	if spec.Path != singboxBinaryRemotePath {
		t.Errorf("Path = %q, want %q", spec.Path, singboxBinaryRemotePath)
	}
	if spec.Mode != 0o755 {
		t.Errorf("Mode = %o, want 0755", spec.Mode)
	}
	if spec.Extract == nil || spec.Extract.Kind != "tar.gz" || spec.Extract.EntryGlob != "*/sing-box" {
		t.Errorf("Extract = %+v, want tar.gz/*/sing-box", spec.Extract)
	}
}

// TestReleaser_ResolveFetchSpec_Mirror verifies that useMirror=true
// wraps the asset download URL with CNMirrorPrefix. The sidecar gh-proxy
// URL won't actually resolve (it points to the real gh-proxy.com) but
// the sidecar fetch is best-effort — failure → SHA="" and we still
// return a usable spec for the agent.
func TestReleaser_ResolveFetchSpec_Mirror(t *testing.T) {
	const version = "1.13.10"
	const osName = "linux"
	const arch = "amd64"
	assetName := singboxAssetName(version, osName, arch)
	var dlURL string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/repos/example/repo/releases/tags/"+releaseTag(version) {
			rel := map[string]any{
				"tag_name": releaseTag(version),
				"assets": []map[string]any{
					{"name": assetName, "browser_download_url": dlURL},
				},
			}
			_ = json.NewEncoder(w).Encode(rel)
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	dlURL = "https://github.com/example/repo/releases/download/" + releaseTag(version) + "/" + assetName

	// Custom HTTP client that fails fast on the mirror-prefixed sidecar
	// URL (its DNS resolves to gh-proxy.com which we don't want to hit
	// from a unit test). The Releaser's sidecar fetch is best-effort so
	// the test just confirms the URL on the returned spec is wrapped.
	rel := &Releaser{BaseURL: srv.URL, Repo: "example/repo", HTTP: srv.Client()}
	spec, _ := rel.ResolveFetchSpec(context.Background(), version, osName, arch, true)
	if !strings.HasPrefix(spec.URL, CNMirrorPrefix) {
		t.Errorf("URL = %q, want prefix %q", spec.URL, CNMirrorPrefix)
	}
	if !strings.HasSuffix(spec.URL, dlURL) {
		t.Errorf("URL = %q, want suffix %q", spec.URL, dlURL)
	}
}

func TestReleaser_ListLatestTagsFiltersUnrelated(t *testing.T) {
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

func TestReleaser_ListLatestTagsPaginatesPastUnrelatedTags(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := r.URL.Query().Get("page")
		switch page {
		case "1":
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
		t.Errorf("ListLatestTags = %v, want [1.13.12]", got)
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

func TestFetchSHA256Sidecar_404Returns_EmptySHA(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	got, err := fetchSHA256Sidecar(context.Background(), srv.Client(), srv.URL+"/missing.sha256")
	if err != nil {
		t.Fatalf("fetchSHA256Sidecar should not error on 404: %v", err)
	}
	if got != "" {
		t.Errorf("expected empty sha on 404, got %q", got)
	}
}

func TestFetchSHA256Sidecar_ParsesSha256SumFormat(t *testing.T) {
	const wantSHA = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprintf(w, "%s  shepherd-singbox.tar.gz\n", wantSHA)
	}))
	defer srv.Close()

	got, err := fetchSHA256Sidecar(context.Background(), srv.Client(), srv.URL+"/x.sha256")
	if err != nil {
		t.Fatal(err)
	}
	if got != wantSHA {
		t.Errorf("got %q, want %q", got, wantSHA)
	}
}
