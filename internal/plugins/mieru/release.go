package mieru

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/ghmirror"
)

type Releaser struct {
	HTTP    *http.Client
	BaseURL string
}

func (r *Releaser) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return &http.Client{Timeout: 60 * time.Second}
}

func (r *Releaser) apiBase() string {
	if r.BaseURL != "" {
		return strings.TrimRight(r.BaseURL, "/")
	}
	return "https://api.github.com"
}

func mitaAssetName(version, arch string) string {
	return fmt.Sprintf("mita_%s_linux_%s.tar.gz", version, arch)
}

func (r *Releaser) ResolveFetchSpec(ctx context.Context, version, osName, arch string, useMirror bool) (agentapi.FileFetch, error) {
	if osName != "linux" {
		return agentapi.FileFetch{}, fmt.Errorf("mita server is Linux-only (got os=%s)", osName)
	}
	if arch != "amd64" && arch != "arm64" {
		return agentapi.FileFetch{}, fmt.Errorf("unsupported arch %q", arch)
	}
	assetName := mitaAssetName(version, arch)
	dlURL, err := r.resolveAssetURL(ctx, version, assetName)
	if err != nil {
		return agentapi.FileFetch{}, fmt.Errorf("resolve asset URL: %w", err)
	}
	shaURL := dlURL + ".sha256.txt"
	if useMirror {
		dlURL = ghmirror.Prefix + dlURL
		shaURL = ghmirror.Prefix + shaURL
	}
	sha, _ := fetchSHA256Sidecar(ctx, r.client(), shaURL)
	return agentapi.FileFetch{
		URL:    dlURL,
		Path:   mitaBinaryRemotePath,
		Mode:   0o755,
		SHA256: sha,
		Extract: &agentapi.FetchExtract{
			Kind:      "tar.gz",
			EntryGlob: "mita",
		},
	}, nil
}

func (r *Releaser) resolveAssetURL(ctx context.Context, version, assetName string) (string, error) {
	u := fmt.Sprintf("%s/repos/enfein/mieru/releases/tags/v%s", r.apiBase(), version)
	body, err := httpGet(ctx, r.client(), u)
	if err != nil {
		return "", err
	}
	var rel struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.Unmarshal(body, &rel); err != nil {
		return "", fmt.Errorf("parse release: %w", err)
	}
	for _, a := range rel.Assets {
		if a.Name == assetName {
			return a.URL, nil
		}
	}
	return "", fmt.Errorf("asset %s not in v%s", assetName, version)
}

func (r *Releaser) ListLatestTags(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 {
		limit = 5
	}
	u := fmt.Sprintf("%s/repos/enfein/mieru/releases?per_page=%d", r.apiBase(), limit)
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

func httpGet(ctx context.Context, c *http.Client, u string) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("User-Agent", "Shepherd")
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

func fetchSHA256Sidecar(ctx context.Context, c *http.Client, u string) (string, error) {
	body, err := httpGet(ctx, c, u)
	if err != nil {
		return "", err
	}
	line := strings.TrimSpace(string(body))
	if i := strings.IndexAny(line, " \t"); i > 0 {
		line = line[:i]
	}
	line = strings.ToLower(line)
	if len(line) != 64 {
		return "", fmt.Errorf("sha256 sidecar has %d hex chars", len(line))
	}
	return line, nil
}
