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
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Releaser downloads and caches sing-box release binaries from GitHub.
//
// Shepherd ships its own sing-box build (with the with_v2ray_api tag so the
// agent's gRPC stats sampler has counters to read — upstream's release
// binaries are compiled without it). The build pipeline lives in
// .github/workflows/sing-box-build.yml; binaries are published as releases
// on this repo with tag pattern `singbox-vX.Y.Z-v2rayapi` and asset names
// `shepherd-singbox-vX.Y.Z-v2rayapi-linux-{arch}.tar.gz`.
type Releaser struct {
	BaseURL  string       // override for tests; default https://api.github.com
	Repo     string       // override for tests; default "hg-claw/Shepherd"
	CacheDir string       // directory to cache extracted binaries
	HTTP     *http.Client // override for tests; default 120s-timeout client
	// MirrorPrefix, when non-empty, is prepended to the github.com asset
	// download URL just before httpGet. Lets mainland-China hosts route
	// the actual binary fetch through a relay (typically
	// https://gh-proxy.com/) without changing the upstream API path —
	// list/lookup still hit api.github.com directly because the proxy
	// doesn't reliably mirror those endpoints.
	MirrorPrefix string
}

const (
	defaultSingboxRepo = "hg-claw/Shepherd"
	// releaseTagPrefix / releaseTagSuffix bracket the version inside a release
	// tag. We need both to round-trip: list → strip → version, and
	// version → wrap → tag for asset lookup.
	releaseTagPrefix = "singbox-"
	releaseTagSuffix = "-v2rayapi"
)

// Binary describes one cached sing-box binary on disk.
type Binary struct {
	Version      string
	OS           string
	Arch         string
	SizeBytes    int64
	Sha256       string    // SHA256 of the downloaded tar.gz
	Path         string    // path to the extracted binary
	DownloadedAt time.Time
}

func (r *Releaser) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 120 * time.Second}
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

// cachedPath returns the path where the extracted binary is stored.
//
// The version segment is the full release tag ("singbox-vX.Y.Z-v2rayapi")
// rather than just "vX.Y.Z" so the cache key naturally invalidates when
// the build flavor changes. Earlier versions of Shepherd cached upstream
// sing-box binaries under "v<version>/sing-box"; after the switch to our
// self-built shepherd-singbox-…-v2rayapi releases (PR #45), a cache hit
// on the old key would have pushed an upstream binary against a config
// that needed with_v2ray_api — sing-box fatal-fails. The new key cannot
// collide with the old one, so the bad cache entries are orphaned
// (occupying disk until manually cleared) but never returned.
func (r *Releaser) cachedPath(version, osName, arch string) string {
	return filepath.Join(r.CacheDir, osName+"-"+arch, releaseTag(version), "sing-box")
}

// Fetch returns the binary, downloading and extracting it if not already cached.
// The Sha256 field in the returned Binary is the SHA256 of the downloaded tar.gz.
func (r *Releaser) Fetch(ctx context.Context, version, osName, arch string) (Binary, error) {
	dest := r.cachedPath(version, osName, arch)

	// Cache hit: binary already extracted on disk.
	if fi, err := os.Stat(dest); err == nil && fi.Size() > 0 {
		sum, err := sha256File(dest)
		if err != nil {
			return Binary{}, fmt.Errorf("sha256 cached file: %w", err)
		}
		return Binary{
			Version:      version,
			OS:           osName,
			Arch:         arch,
			SizeBytes:    fi.Size(),
			Sha256:       sum,
			Path:         dest,
			DownloadedAt: fi.ModTime(),
		}, nil
	}

	// Resolve asset download URL from the GitHub releases list.
	assetName := singboxAssetName(version, osName, arch)
	dlURL, err := r.resolveAssetURL(ctx, version, assetName)
	if err != nil {
		return Binary{}, fmt.Errorf("resolve asset URL: %w", err)
	}

	// CN-mirror prefix on the actual download. resolveAssetURL above
	// stays on api.github.com (gh-proxy.com doesn't reliably mirror API
	// endpoints); only the binary fetch gets routed through.
	if r.MirrorPrefix != "" {
		dlURL = r.MirrorPrefix + dlURL
	}

	// Download the tar.gz.
	tarBuf, err := httpGet(ctx, r.client(), dlURL)
	if err != nil {
		return Binary{}, fmt.Errorf("download %s: %w", dlURL, err)
	}

	// Compute SHA256 of the tar.gz before extraction.
	h := sha256.Sum256(tarBuf)
	tarSHA := hex.EncodeToString(h[:])

	// Extract the sing-box binary from inside the versioned directory.
	binBytes, err := extractSingbox(tarBuf, "sing-box")
	if err != nil {
		return Binary{}, fmt.Errorf("extract sing-box from tar.gz: %w", err)
	}

	// Write extracted binary to cache.
	if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
		return Binary{}, fmt.Errorf("mkdir cache: %w", err)
	}
	if err := os.WriteFile(dest, binBytes, 0755); err != nil {
		return Binary{}, fmt.Errorf("write cached binary: %w", err)
	}

	return Binary{
		Version:      version,
		OS:           osName,
		Arch:         arch,
		SizeBytes:    int64(len(binBytes)),
		Sha256:       tarSHA,
		Path:         dest,
		DownloadedAt: time.Now().UTC(),
	}, nil
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

// extractSingbox searches the tar.gz for a file named targetName (base name)
// at any path depth (e.g., sing-box-1.10.0-linux-amd64/sing-box) and returns
// its contents with the executable bit preserved.
func extractSingbox(tarGzData []byte, targetName string) ([]byte, error) {
	gr, err := gzip.NewReader(bytes.NewReader(tarGzData))
	if err != nil {
		return nil, fmt.Errorf("gzip reader: %w", err)
	}
	defer func() { _ = gr.Close() }()

	tr := tar.NewReader(gr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("tar read: %w", err)
		}
		// Skip directories and non-regular files.
		if hdr.Typeflag != tar.TypeReg && hdr.Typeflag != 0 {
			continue
		}
		base := filepath.Base(hdr.Name)
		// Match "sing-box" or "sing-box.exe" (Windows).
		if base == targetName || strings.TrimSuffix(base, ".exe") == targetName {
			data, err := io.ReadAll(tr)
			if err != nil {
				return nil, fmt.Errorf("read entry %s: %w", hdr.Name, err)
			}
			return data, nil
		}
	}
	return nil, fmt.Errorf("entry %q not found in tar.gz", targetName)
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

// sha256File computes the SHA256 hex digest of a file's contents.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
