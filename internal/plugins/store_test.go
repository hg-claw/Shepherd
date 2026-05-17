package plugins

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

func TestStore_EnableDisable(t *testing.T) {
	d := openTestDB(t)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	if err := s.UpsertEnabled(ctx, "x", true); err != nil {
		t.Fatal(err)
	}
	row, err := s.Get(ctx, "x")
	if err != nil || !row.Enabled {
		t.Fatalf("Get(x).Enabled = %v err=%v", row.Enabled, err)
	}
	if err := s.UpsertEnabled(ctx, "x", false); err != nil {
		t.Fatal(err)
	}
	row, _ = s.Get(ctx, "x")
	if row.Enabled {
		t.Fatal("expected disabled after second upsert")
	}
}

func TestStore_ConfigRoundTrip(t *testing.T) {
	d := openTestDB(t)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	_ = s.UpsertEnabled(ctx, "x", false)
	if err := s.PutConfig(ctx, "x", []byte(`{"k":1}`)); err != nil {
		t.Fatal(err)
	}
	row, _ := s.Get(ctx, "x")
	if string(row.ConfigJSON) != `{"k":1}` {
		t.Fatalf("config = %q", row.ConfigJSON)
	}
}

func TestStore_HostsCRUD(t *testing.T) {
	d := openTestDB(t)
	// seed a server row so the FK holds — `name` is the only NOT NULL field without default
	_, _ = d.Exec(`INSERT INTO servers(name) VALUES('h1')`)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	_ = s.UpsertEnabled(ctx, "x", true)
	row, err := s.UpsertHost(ctx, "x", 1, []byte(`{"port":443}`), "pending")
	if err != nil {
		t.Fatal(err)
	}
	if row.ID == 0 {
		t.Fatal("expected non-zero id")
	}
	hosts, _ := s.ListHosts(ctx, "x")
	if len(hosts) != 1 {
		t.Fatalf("ListHosts = %d", len(hosts))
	}
	if err := s.SetHostStatus(ctx, "x", 1, "running", "1.8.11", ""); err != nil {
		t.Fatal(err)
	}
	h, _ := s.GetHost(ctx, "x", 1)
	if h.Status != "running" || h.DeployedVersion.String != "1.8.11" {
		t.Fatalf("after SetHostStatus: %+v", h)
	}
	var cfg map[string]any
	_ = json.Unmarshal(h.ConfigJSON, &cfg)
	if cfg["port"].(float64) != 443 {
		t.Fatalf("config lost in roundtrip: %v", cfg)
	}
}

func TestStore_HostCountByPlugin(t *testing.T) {
	d := openTestDB(t)
	_, _ = d.Exec(`INSERT INTO servers(name) VALUES('h1')`)
	_, _ = d.Exec(`INSERT INTO servers(name) VALUES('h2')`)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	_ = s.UpsertEnabled(ctx, "x", true)
	_, _ = s.UpsertHost(ctx, "x", 1, []byte(`{}`), "running")
	_, _ = s.UpsertHost(ctx, "x", 2, []byte(`{}`), "running")
	counts, err := s.HostCountByPlugin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if counts["x"] != 2 {
		t.Fatalf("HostCountByPlugin[x] = %d", counts["x"])
	}
}

func TestStore_DeleteHost(t *testing.T) {
	d := openTestDB(t)
	_, _ = d.Exec(`INSERT INTO servers(name) VALUES('h1')`)
	s := &Store{DB: d, Now: time.Now}
	ctx := context.Background()
	_ = s.UpsertEnabled(ctx, "x", true)
	_, _ = s.UpsertHost(ctx, "x", 1, []byte(`{}`), "running")
	if err := s.DeleteHost(ctx, "x", 1); err != nil {
		t.Fatal(err)
	}
	hosts, _ := s.ListHosts(ctx, "x")
	if len(hosts) != 0 {
		t.Fatalf("expected 0 hosts after delete, got %d", len(hosts))
	}
}
