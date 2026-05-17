package cloudflare

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClient_ListZonesForwardsToken(t *testing.T) {
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": true,
			"result":  []map[string]any{{"id": "z1", "name": "example.com"}},
		})
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Token: "tk_secret"}
	zones, err := c.ListZones(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer tk_secret" {
		t.Fatalf("forwarded auth = %q", gotAuth)
	}
	if len(zones) != 1 || zones[0]["name"] != "example.com" {
		t.Fatalf("zones = %v", zones)
	}
}

func TestClient_WrapsCFError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"success": false,
			"errors":  []map[string]any{{"code": 10000, "message": "Authentication error"}},
		})
	}))
	defer srv.Close()
	c := &Client{BaseURL: srv.URL, Token: "bad"}
	_, err := c.ListZones(context.Background())
	if err == nil || !strings.Contains(err.Error(), "10000") {
		t.Fatalf("expected CF error wrapped, got %v", err)
	}
}
