package xray

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/hg-claw/Shepherd/internal/ghmirror"
)

func TestReleaser_ResolveFetchSpec_Direct(t *testing.T) {
	zipBytes := []byte("FAKE-XRAY-ZIP")
	dgst := sha256.Sum256(zipBytes)
	wantSHA := hex.EncodeToString(dgst[:])

	mux := http.NewServeMux()
	mux.HandleFunc("/releases/download/v1.2.3/Xray-linux-64.zip.dgst", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "SHA2-256= "+wantSHA+"\n")
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	r := &Releaser{BaseURL: srv.URL}
	spec, err := r.ResolveFetchSpec(context.Background(), "1.2.3", "linux", "amd64", false)
	if err != nil {
		t.Fatal(err)
	}
	wantURL := srv.URL + "/releases/download/v1.2.3/Xray-linux-64.zip"
	if spec.URL != wantURL {
		t.Errorf("URL = %q, want %q", spec.URL, wantURL)
	}
	if spec.SHA256 != wantSHA {
		t.Errorf("SHA256 = %q, want %q", spec.SHA256, wantSHA)
	}
	if spec.Path != xrayBinaryRemotePathUnix {
		t.Errorf("Path = %q, want %q", spec.Path, xrayBinaryRemotePathUnix)
	}
	if spec.Extract == nil || spec.Extract.Kind != "zip" || spec.Extract.EntryGlob != "xray" {
		t.Errorf("Extract = %+v, want zip/xray", spec.Extract)
	}
}

func TestReleaser_BuildAssetURLs_Mirror(t *testing.T) {
	r := &Releaser{BaseURL: "https://github.com/XTLS/Xray-core"}
	zipURL, dgstURL := r.buildAssetURLs("1.2.3", "linux", "amd64", true)
	if !strings.HasPrefix(zipURL, ghmirror.Prefix) {
		t.Errorf("zipURL = %q, want prefix %q", zipURL, ghmirror.Prefix)
	}
	if !strings.HasPrefix(dgstURL, ghmirror.Prefix) {
		t.Errorf("dgstURL = %q, want prefix %q", dgstURL, ghmirror.Prefix)
	}
	if !strings.HasSuffix(zipURL, "/Xray-linux-64.zip") {
		t.Errorf("zipURL = %q, missing asset suffix", zipURL)
	}
	if !strings.HasSuffix(dgstURL, "/Xray-linux-64.zip.dgst") {
		t.Errorf("dgstURL = %q, missing dgst suffix", dgstURL)
	}
}

func TestReleaser_BuildAssetURLs_Direct(t *testing.T) {
	r := &Releaser{BaseURL: "https://github.com/XTLS/Xray-core"}
	zipURL, dgstURL := r.buildAssetURLs("1.2.3", "linux", "amd64", false)
	if strings.HasPrefix(zipURL, ghmirror.Prefix) {
		t.Errorf("zipURL = %q, should NOT have mirror prefix", zipURL)
	}
	if strings.HasPrefix(dgstURL, ghmirror.Prefix) {
		t.Errorf("dgstURL = %q, should NOT have mirror prefix", dgstURL)
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

func TestFetchDigest_PicksSHA256FromMultilineDgst(t *testing.T) {
	const want = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"
	body := "MD5= 00000000000000000000000000000000\n" +
		"SHA1= 0000000000000000000000000000000000000000\n" +
		"SHA2-256= " + want + "\n" +
		"SHA2-512= 0000000000000000000000000000000000000000000000000000000000000000" +
		"0000000000000000000000000000000000000000000000000000000000000000\n"

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, body)
	}))
	defer srv.Close()

	got, err := fetchDigest(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatalf("fetchDigest: %v", err)
	}
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
