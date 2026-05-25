package singbox

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

// Releaser resolves shepherd-singbox release metadata (asset URL + sha256
// sidecar) from GitHub. The agent does the actual download — the server
// only hits api.github.com for the small JSON lookups.
//
// Shepherd ships its own sing-box build (with the with_v2ray_api tag so the
// agent's gRPC stats sampler has counters to read — upstream's release
// binaries are compiled without it). The build pipeline lives in
// .github/workflows/sing-box-build.yml; binaries are published as releases
// on this repo with tag pattern `singbox-vX.Y.Z-v2rayapi` and asset names
// `shepherd-singbox-vX.Y.Z-v2rayapi-linux-{arch}.tar.gz`. Each asset
// has a sibling `.sha256` text file (single hex digest line).
type Releaser struct {
	BaseURL string       // override for tests; default https://api.github.com
	Repo    string       // override for tests; default "hg-claw/Shepherd"
	HTTP    *http.Client // override for tests; default 30s-timeout client
}

// CNMirrorPrefix is prepended to the github.com asset URL when a deploy
// asks for the CN mirror. Kept here so swapping mirrors is a one-line
// change. The same constant lives in xray's Releaser for symmetry.
const CNMirrorPrefix = "https://gh-proxy.com/"

const (
	defaultSingboxRepo = "hg-claw/Shepherd"
	// releaseTagPrefix / releaseTagSuffix bracket the version inside a release
	// tag. We need both to round-trip: list → strip → version, and
	// version → wrap → tag for asset lookup.
	releaseTagPrefix = "singbox-"
	releaseTagSuffix = "-v2rayapi"
)

func (r *Releaser) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

func (r *Releaser) apiBase() string {
	if r.BaseURL != "" {
		return strings.TrimRight(r.BaseURL, "/")
	}
	return "https://api.github.com"
}

func (r *Releaser) repo() string {
	if r.Repo != "" {
		return r.Repo
	}
	return defaultSingboxRepo
}

// releaseTag wraps a version string ("1.13.10") into the GitHub release tag
// our build pipeline uses ("singbox-v1.13.10-v2rayapi"). Inverse of
// stripReleaseTag.
func releaseTag(version string) string {
	return releaseTagPrefix + "v" + version + releaseTagSuffix
}

// stripReleaseTag is the inverse of releaseTag — returns "" when the tag
// doesn't match our prefix/suffix, so callers can filter unrelated
// releases (Shepherd's own v0.7.x tags etc.) out of the list endpoint.
func stripReleaseTag(tag string) string {
	if !strings.HasPrefix(tag, releaseTagPrefix) || !strings.HasSuffix(tag, releaseTagSuffix) {
		return ""
	}
	mid := strings.TrimSuffix(strings.TrimPrefix(tag, releaseTagPrefix), releaseTagSuffix)
	return strings.TrimPrefix(mid, "v")
}

// singboxAssetName maps (version, os, arch) to the tar.gz asset filename.
// Format: shepherd-singbox-vX.Y.Z-v2rayapi-{os}-{arch}.tar.gz
// arch mapping: arm → armv7; everything else passes through unchanged.
func singboxAssetName(version, osName, arch string) string {
	a := arch
	if arch == "arm" {
		a = "armv7"
	}
	return fmt.Sprintf("shepherd-singbox-v%s-v2rayapi-%s-%s.tar.gz", version, osName, a)
}

// ResolveFetchSpec returns the FileFetch payload that, when sent to an
// agent, causes it to download and install shepherd-singbox at version
// for (osName, arch). The server only hits api.github.com here — the
// tarball never touches the Shepherd server's disk.
//
// useMirror=true wraps the asset URL with CNMirrorPrefix so mainland-China
// agents can fetch via the gh-proxy relay. The .sha256 sidecar URL is
// wrapped too (it's also on github.com). The api.github.com lookup stays
// direct because gh-proxy doesn't reliably mirror the API.
func (r *Releaser) ResolveFetchSpec(ctx context.Context, version, osName, arch string, useMirror bool) (agentapi.FileFetch, error) {
	assetName := singboxAssetName(version, osName, arch)
	dlURL, err := r.resolveAssetURL(ctx, version, assetName)
	if err != nil {
		return agentapi.FileFetch{}, fmt.Errorf("resolve asset URL: %w", err)
	}
	shaURL := dlURL + ".sha256"
	if useMirror {
		dlURL = CNMirrorPrefix + dlURL
		shaURL = CNMirrorPrefix + shaURL
	}
	// Sidecar fetch is best-effort. Older shepherd-singbox releases
	// (pre-build-pipeline-update) don't ship .sha256; in that case we
	// pass SHA256="" so the agent skips verification and TLS is the
	// only integrity check.
	sha, _ := fetchSHA256Sidecar(ctx, r.client(), shaURL)
	return agentapi.FileFetch{
		URL:    dlURL,
		Path:   singboxBinaryRemotePath,
		Mode:   0o755,
		SHA256: sha,
		Extract: &agentapi.FetchExtract{
			Kind:      "tar.gz",
			EntryGlob: "*/sing-box",
		},
	}, nil
}

// fetchSHA256Sidecar GETs a .sha256 text file (single hex digest line,
// optionally with a filename suffix in sha256sum format) and returns the
// hex digest. Tolerates trailing whitespace. Empty string + nil error
// when 404 — older releases simply don't have one.
func fetchSHA256Sidecar(ctx context.Context, c *http.Client, u string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return "", err
	}
	resp, err := c.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return "", nil
	}
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("sha256 sidecar HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	// sha256sum format: "<hex>  <filename>" — take the first field.
	line := strings.TrimSpace(string(body))
	if i := strings.IndexAny(line, " \t"); i > 0 {
		line = line[:i]
	}
	if len(line) != 64 {
		return "", fmt.Errorf("sha256 sidecar has %d hex chars, want 64", len(line))
	}
	return strings.ToLower(line), nil
}

// ListLatestTags returns up to limit recent shepherd-singbox release versions
// (no "v" prefix, no "singbox-…-v2rayapi" wrapper). Releases that don't match
// our tag pattern (e.g. the Shepherd server's own vX.Y.Z tags) are filtered
// out — both flavours live in the same GitHub repo.
//
// Pagination: the singbox build pipeline is on a separate cadence from the
// main Shepherd release cycle, so the most recent N pages of /releases can
// be entirely Shepherd vX.Y.Z tags with NO matching singbox-… tag. Pre-fix
// we just over-fetched by 4× and hoped — once we had ~20 Shepherd releases
// between singbox builds, the filter starved and returned []. Walk pages
// until we hit limit matches or maxPages.
func (r *Releaser) ListLatestTags(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 5
	}
	const perPage = 100 // GitHub max
	const maxPages = 5  // 500 releases — way past any realistic gap

	out := make([]string, 0, limit)
	for page := 1; page <= maxPages; page++ {
		u := fmt.Sprintf("%s/repos/%s/releases?per_page=%d&page=%d",
			r.apiBase(), r.repo(), perPage, page)
		body, err := httpGet(ctx, r.client(), u)
		if err != nil {
			return nil, err
		}
		var entries []struct {
			TagName string `json:"tag_name"`
		}
		if err := json.Unmarshal(body, &entries); err != nil {
			return nil, fmt.Errorf("parse releases: %w", err)
		}
		// Empty page = ran out of releases entirely; return what we have.
		if len(entries) == 0 {
			break
		}
		for _, e := range entries {
			v := stripReleaseTag(e.TagName)
			if v == "" {
				continue
			}
			out = append(out, v)
			if len(out) >= limit {
				return out, nil
			}
		}
	}
	return out, nil
}

// resolveAssetURL fetches the GitHub release for the requested version and
// returns the download URL for the named asset.
//
// Pre-fix this iterated `/releases` (first page only) and matched by tag
// name client-side — same starvation bug as ListLatestTags once the
// release fell off page 1. Use GitHub's tag-direct endpoint instead so
// the lookup is O(1) regardless of how many intervening Shepherd
// releases have piled up.
func (r *Releaser) resolveAssetURL(ctx context.Context, version, assetName string) (string, error) {
	want := releaseTag(version)
	u := fmt.Sprintf("%s/repos/%s/releases/tags/%s", r.apiBase(), r.repo(), want)
	body, err := httpGet(ctx, r.client(), u)
	if err != nil {
		return "", fmt.Errorf("fetch release %q: %w", want, err)
	}
	var rel struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return "", fmt.Errorf("parse release JSON: %w", err)
	}
	for _, a := range rel.Assets {
		if a.Name == assetName {
			return a.BrowserDownloadURL, nil
		}
	}
	return "", fmt.Errorf("asset %q not found in release %q", assetName, want)
}

// httpGet performs a GET request and returns the response body.
// Returns an error for non-2xx status codes.
func httpGet(ctx context.Context, c *http.Client, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("HTTP %d for %s", resp.StatusCode, u)
	}
	return io.ReadAll(resp.Body)
}
