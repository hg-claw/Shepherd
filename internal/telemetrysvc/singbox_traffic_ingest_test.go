package telemetrysvc

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	sbplugin "github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

func newIngestWithSingboxTraffic(t *testing.T) (*Ingest, int64) {
	t.Helper()
	ing, sid := newIngest(t)
	if err := plugins.RunPluginMigrations(context.Background(), ing.DB, "singbox",
		sbplugin.Migrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}
	return ing, sid
}

func TestWriteSingboxTrafficBatch_InsertsRows(t *testing.T) {
	ing, sid := newIngestWithSingboxTraffic(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	samples := []agentapi.SingboxTrafficSample{
		{Tag: "landing-aabb1122", Kind: "landing", TS: now, BytesUp: 1024, BytesDown: 2048},
		{Tag: "relay-ccdd3344", Kind: "relay", TS: now, BytesUp: 512, BytesDown: 1024},
	}
	if err := ing.WriteSingboxTrafficBatch(ctx, sid, samples); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := ing.DB.GetContext(ctx, &n,
		"SELECT COUNT(*) FROM singbox_traffic_raw WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Errorf("rows = %d, want 2", n)
	}
	var up int64
	_ = ing.DB.GetContext(ctx, &up,
		"SELECT bytes_up FROM singbox_traffic_raw WHERE tag='landing-aabb1122'")
	if up != 1024 {
		t.Errorf("bytes_up = %d, want 1024", up)
	}
}

func TestWriteSingboxTrafficBatch_EmptyIsNoOp(t *testing.T) {
	ing, sid := newIngestWithSingboxTraffic(t)
	if err := ing.WriteSingboxTrafficBatch(context.Background(), sid, nil); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = ing.DB.Get(&n, "SELECT COUNT(*) FROM singbox_traffic_raw WHERE server_id=?", sid)
	if n != 0 {
		t.Errorf("rows = %d after empty batch, want 0", n)
	}
}

func TestHandleFrame_SingboxTraffic(t *testing.T) {
	ing, sid := newIngestWithSingboxTraffic(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	batch := agentapi.SingboxTrafficBatch{Samples: []agentapi.SingboxTrafficSample{
		{Tag: "landing-aabb1122", Kind: "landing", TS: now, BytesUp: 100, BytesDown: 200},
	}}
	env, _ := agentapi.Frame(agentapi.TypeSingboxTraffic, batch)
	ing.HandleFrame(ctx, sid, env)

	var n int
	_ = ing.DB.GetContext(ctx, &n,
		"SELECT COUNT(*) FROM singbox_traffic_raw WHERE server_id=?", sid)
	if n != 1 {
		t.Errorf("rows = %d after HandleFrame, want 1", n)
	}
}
