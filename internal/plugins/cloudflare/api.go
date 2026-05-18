package cloudflare

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func (c *Client) base() string {
	if c.BaseURL == "" {
		return "https://api.cloudflare.com/client/v4"
	}
	return strings.TrimRight(c.BaseURL, "/")
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

type cfResp struct {
	Success bool                       `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
	Result json.RawMessage `json:"result"`
}

func (c *Client) do(ctx context.Context, method, path string, body any) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(ctx, method, c.base()+path, reader)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http().Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(resp.Body)
	var parsed cfResp
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("non-json CF response (status %d): %s", resp.StatusCode, raw)
	}
	if !parsed.Success {
		if len(parsed.Errors) > 0 {
			return nil, fmt.Errorf("CF API: %d %s", parsed.Errors[0].Code, parsed.Errors[0].Message)
		}
		return nil, fmt.Errorf("CF API: status %d", resp.StatusCode)
	}
	return parsed.Result, nil
}

func (c *Client) ListZones(ctx context.Context) ([]map[string]any, error) {
	raw, err := c.do(ctx, "GET", "/zones?per_page=50", nil)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) ListRecords(ctx context.Context, zoneID string) ([]map[string]any, error) {
	raw, err := c.do(ctx, "GET", "/zones/"+zoneID+"/dns_records?per_page=200", nil)
	if err != nil {
		return nil, err
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) CreateRecord(ctx context.Context, zoneID string, body map[string]any) (map[string]any, error) {
	raw, err := c.do(ctx, "POST", "/zones/"+zoneID+"/dns_records", body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) PatchRecord(ctx context.Context, zoneID, recordID string, body map[string]any) (map[string]any, error) {
	raw, err := c.do(ctx, "PATCH", "/zones/"+zoneID+"/dns_records/"+recordID, body)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) DeleteRecord(ctx context.Context, zoneID, recordID string) error {
	_, err := c.do(ctx, "DELETE", "/zones/"+zoneID+"/dns_records/"+recordID, nil)
	return err
}
