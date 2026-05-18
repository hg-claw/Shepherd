package xray

import (
	"archive/zip"
	"bytes"
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

// Releaser downloads and caches xray release binaries from GitHub.
type Releaser struct {
	BaseURL  string // https://github.com/XTLS/Xray-core (override for tests)
	CacheDir string // typically deps.DataDir + "/cache"
	HTTP     *http.Client
}

func defaultClient() *http.Client {
	return &http.Client{Timeout: 60 * time.Second}
}

// Binary describes one cached xray binary on disk.
type Binary struct {
	Version      string
	OS           string
	Arch         string
	SizeBytes    int64
	Sha256       string
	Path         string
	DownloadedAt time.Time
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

func (r *Releaser) cachedBinaryPath(version, osName, arch string) string {
	return filepath.Join(r.CacheDir, osName+"-"+arch, "v"+version, "xray")
}

// Fetch returns a cached binary or downloads + verifies + extracts it.
func (r *Releaser) Fetch(ctx context.Context, version, osName, arch string) (Binary, error) {
	out := r.cachedBinaryPath(version, osName, arch)
	if st, err := os.Stat(out); err == nil {
		sum, err := sha256File(out)
		if err == nil {
			return Binary{
				Version: version, OS: osName, Arch: arch,
				SizeBytes: st.Size(), Sha256: sum, Path: out,
				DownloadedAt: st.ModTime(),
			}, nil
		}
	}

	if err := os.MkdirAll(filepath.Dir(out), 0755); err != nil {
		return Binary{}, err
	}

	zipURL := fmt.Sprintf("%s/releases/download/v%s/Xray-%s-%s.zip", r.base(), version, xrayOS(osName), xrayArch(arch))
	dgstURL := zipURL + ".dgst"
	httpc := r.HTTP
	if httpc == nil {
		httpc = defaultClient()
	}

	expectedSha, err := fetchDigest(ctx, httpc, dgstURL)
	if err != nil {
		_ = os.RemoveAll(filepath.Dir(out))
		return Binary{}, fmt.Errorf("fetch digest: %w", err)
	}

	zipBody, err := httpGet(ctx, httpc, zipURL)
	if err != nil {
		_ = os.RemoveAll(filepath.Dir(out))
		return Binary{}, fmt.Errorf("fetch zip: %w", err)
	}
	actual := sha256.Sum256(zipBody)
	actualHex := hex.EncodeToString(actual[:])
	if !strings.EqualFold(actualHex, expectedSha) {
		_ = os.RemoveAll(filepath.Dir(filepath.Dir(out)))
		return Binary{}, fmt.Errorf("sha256 mismatch: want %s got %s", expectedSha, actualHex)
	}

	if err := extractXray(zipBody, out); err != nil {
		_ = os.RemoveAll(filepath.Dir(filepath.Dir(out)))
		return Binary{}, fmt.Errorf("extract: %w", err)
	}

	st, _ := os.Stat(out)
	return Binary{
		Version: version, OS: osName, Arch: arch,
		SizeBytes: st.Size(), Sha256: actualHex,
		Path: out, DownloadedAt: time.Now().UTC(),
	}, nil
}

func httpGet(ctx context.Context, c *http.Client, u string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
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
	// Format: "SHA2-256= <hex>\n"
	line := strings.TrimSpace(string(body))
	idx := strings.LastIndex(line, " ")
	if idx == -1 {
		return "", fmt.Errorf("malformed dgst line: %q", line)
	}
	return strings.ToLower(strings.TrimSpace(line[idx+1:])), nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
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

func extractXray(zipBytes []byte, outPath string) error {
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		return err
	}
	for _, f := range zr.File {
		base := filepath.Base(f.Name)
		if base != "xray" && base != "xray.exe" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		w, err := os.OpenFile(outPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(w, rc)
		rc.Close()
		w.Close()
		return err
	}
	return fmt.Errorf("no xray binary found in zip")
}
