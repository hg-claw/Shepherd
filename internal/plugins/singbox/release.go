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
type Releaser struct {
	BaseURL  string       // override for tests; default https://api.github.com
	CacheDir string       // directory to cache extracted binaries
	HTTP     *http.Client // override for tests; default 120s-timeout client
}

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

// singboxAssetName maps (version, os, arch) to the tar.gz asset filename.
// sing-box uses: sing-box-{version}-{os}-{arch}.tar.gz
// arch mapping: arm → armv7; everything else is passed through unchanged.
func singboxAssetName(version, osName, arch string) string {
	a := arch
	if arch == "arm" {
		a = "armv7"
	}
	return fmt.Sprintf("sing-box-%s-%s-%s.tar.gz", version, osName, a)
}

// cachedPath returns the path where the extracted binary is stored.
func (r *Releaser) cachedPath(version, osName, arch string) string {
	return filepath.Join(r.CacheDir, osName+"-"+arch, "v"+version, "sing-box")
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

// ListLatestTags returns up to limit recent sing-box release tags (no "v" prefix).
func (r *Releaser) ListLatestTags(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 5
	}
	u := fmt.Sprintf("%s/repos/SagerNet/sing-box/releases?per_page=%d", r.apiBase(), limit)
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
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, strings.TrimPrefix(e.TagName, "v"))
	}
	return out, nil
}

// resolveAssetURL fetches the GitHub releases list and returns the download URL
// for the named asset in the given version's release.
func (r *Releaser) resolveAssetURL(ctx context.Context, version, assetName string) (string, error) {
	u := r.apiBase() + "/repos/SagerNet/sing-box/releases"
	body, err := httpGet(ctx, r.client(), u)
	if err != nil {
		return "", fmt.Errorf("fetch releases: %w", err)
	}
	var releases []struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name               string `json:"name"`
			BrowserDownloadURL string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &releases); err != nil {
		return "", fmt.Errorf("parse releases JSON: %w", err)
	}
	want := "v" + version
	for _, rel := range releases {
		if rel.TagName != want {
			continue
		}
		for _, a := range rel.Assets {
			if a.Name == assetName {
				return a.BrowserDownloadURL, nil
			}
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
