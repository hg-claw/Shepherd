package xray

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// Releaser resolves xray release metadata. The actual zip download
// happens on the agent — server-side methods only do the small API
// lookups and .dgst sidecar fetch.
type Releaser struct {
	BaseURL string // https://github.com/XTLS/Xray-core (override for tests)
	HTTP    *http.Client
}

// CNMirrorPrefix is prepended to the github.com asset URL when a deploy
// asks for the CN mirror. Kept symmetric with singbox.CNMirrorPrefix.
const CNMirrorPrefix = "https://gh-proxy.com/"

func defaultClient() *http.Client {
	return &http.Client{Timeout: 60 * time.Second}
}

// xrayOS maps Go runtime.GOOS to xray's release-asset OS token.
func xrayOS(o string) string {
	if o == "darwin" {
		return "macos"
	}
	return o
}

// xrayArch maps Go runtime.GOARCH to xray's release-asset arch token.
// xray names assets like Xray-linux-64.zip (amd64 → "64"), Xray-linux-arm64-v8a.zip, etc.
// See https://github.com/XTLS/Xray-core/releases for the full set.
func xrayArch(a string) string {
	switch a {
	case "amd64", "x86_64":
		return "64"
	case "386", "i386":
		return "32"
	case "arm64", "aarch64":
		return "arm64-v8a"
	case "arm":
		return "arm32-v7a"
	case "mipsle":
		return "mips32le"
	default:
		// mips64, mips64le, riscv64, s390x all match the Go name verbatim.
		return a
	}
}

func (r *Releaser) base() string {
	if r.BaseURL == "" {
		return "https://github.com/XTLS/Xray-core"
	}
	return strings.TrimRight(r.BaseURL, "/")
}

// buildAssetURLs returns the (download, digest) URLs for a given version.
// useMirror wraps both with CNMirrorPrefix. Split out so URL construction
// is testable without round-tripping the digest fetch.
func (r *Releaser) buildAssetURLs(version, osName, arch string, useMirror bool) (zipURL, dgstURL string) {
	zipURL = fmt.Sprintf("%s/releases/download/v%s/Xray-%s-%s.zip", r.base(), version, xrayOS(osName), xrayArch(arch))
	dgstURL = zipURL + ".dgst"
	if useMirror {
		zipURL = CNMirrorPrefix + zipURL
		dgstURL = CNMirrorPrefix + dgstURL
	}
	return
}

// ResolveFetchSpec returns the FileFetch payload that, sent to an agent,
// causes it to download and install Xray version (osName, arch). Server
// fetches the small .dgst sidecar from XTLS to populate SHA256 — Xray
// has always published per-release digests so this is mandatory.
//
// useMirror=true wraps both the zip URL and the .dgst URL with
// CNMirrorPrefix. API endpoints stay direct.
func (r *Releaser) ResolveFetchSpec(ctx context.Context, version, osName, arch string, useMirror bool) (agentapi.FileFetch, error) {
	zipURL, dgstURL := r.buildAssetURLs(version, osName, arch, useMirror)
	httpc := r.HTTP
	if httpc == nil {
		httpc = defaultClient()
	}
	expectedSha, err := fetchDigest(ctx, httpc, dgstURL)
	if err != nil {
		return agentapi.FileFetch{}, fmt.Errorf("fetch digest: %w", err)
	}
	return agentapi.FileFetch{
		URL:    zipURL,
		Path:   xrayBinaryRemotePathUnix,
		Mode:   0o755,
		SHA256: expectedSha,
		Extract: &agentapi.FetchExtract{
			Kind:      "zip",
			EntryGlob: "xray",
		},
	}, nil
}

func httpGet(ctx context.Context, c *http.Client, u string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func fetchDigest(ctx context.Context, c *http.Client, u string) (string, error) {
	body, err := httpGet(ctx, c, u)
	if err != nil {
		return "", err
	}
	// xray .dgst is multi-line; we want only the SHA2-256 entry. Both `=`
	// and `= ` separators are tolerated.
	for _, raw := range strings.Split(string(body), "\n") {
		line := strings.TrimSpace(raw)
		if !strings.HasPrefix(strings.ToUpper(line), "SHA2-256") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		hexStr := strings.ToLower(strings.TrimSpace(parts[1]))
		if len(hexStr) != 64 {
			return "", fmt.Errorf("SHA2-256 line has %d hex chars, want 64: %q", len(hexStr), line)
		}
		return hexStr, nil
	}
	return "", fmt.Errorf("no SHA2-256 entry in dgst body")
}

type releaseEntry struct {
	TagName string `json:"tag_name"`
}

// ListLatestTags returns up to `limit` recent release tags (no "v" prefix).
// Falls back to the github.com/XTLS/Xray-core API; respects r.BaseURL for tests
// by appending "/repos/XTLS/Xray-core/releases".
func (r *Releaser) ListLatestTags(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 5
	}
	api := "https://api.github.com"
	if r.BaseURL != "" {
		api = strings.TrimRight(r.BaseURL, "/")
	}
	u := fmt.Sprintf("%s/repos/XTLS/Xray-core/releases?per_page=%d", api, limit)
	httpc := r.HTTP
	if httpc == nil {
		httpc = defaultClient()
	}
	body, err := httpGet(ctx, httpc, u)
	if err != nil {
		return nil, err
	}
	var entries []releaseEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("parse releases: %w", err)
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, strings.TrimPrefix(e.TagName, "v"))
	}
	return out, nil
}

