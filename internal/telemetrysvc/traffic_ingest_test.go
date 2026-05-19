package telemetrysvc

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/plugins"
	xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"
)

func newIngestWithTraffic(t *testing.T) (*Ingest, int64) {
	t.Helper()
	ing, sid := newIngest(t) // reuse helper from ingest_test.go
	// run xray plugin migrations to create traffic tables
	migs := xrayplugin.Migrations()
	if err := plugins.RunPluginMigrations(context.Background(), ing.DB, "xray", migs); err != nil {
		t.Fatal(err)
	}
	return ing, sid
}

func TestWriteTrafficBatch_InsertsRows(t *testing.T) {
	ing, sid := newIngestWithTraffic(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	samples := []agentapi.XrayTrafficSample{
		{Tag: "vless-reality-8443", Kind: "inbound", TS: now, BytesUp: 1024, BytesDown: 2048},
		{Tag: "vmess-ws-443", Kind: "inbound", TS: now, BytesUp: 512, BytesDown: 1024},
		{Tag: "direct", Kind: "outbound", TS: now, BytesUp: 300, BytesDown: 400},
	}
	if err := ing.WriteTrafficBatch(ctx, sid, samples); err != nil {
		t.Fatal(err)
	}

	var n int
	if err := ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM xray_traffic_raw WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if n != 3 {
		t.Errorf("rows = %d, want 3", n)
	}
	var up int64
	_ = ing.DB.GetContext(ctx, &up, "SELECT bytes_up FROM xray_traffic_raw WHERE tag='vless-reality-8443'")
	if up != 1024 {
		t.Errorf("bytes_up = %d, want 1024", up)
	}
}

func TestWriteTrafficBatch_EmptySamples(t *testing.T) {
	ing, sid := newIngestWithTraffic(t)
	if err := ing.WriteTrafficBatch(context.Background(), sid, nil); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = ing.DB.Get(&n, "SELECT COUNT(*) FROM xray_traffic_raw WHERE server_id=?", sid)
	if n != 0 {
		t.Errorf("rows = %d after empty batch, want 0", n)
	}
}

func TestHandleFrame_XrayTraffic(t *testing.T) {
	ing, sid := newIngestWithTraffic(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	batch := agentapi.XrayTrafficBatch{Samples: []agentapi.XrayTrafficSample{
		{Tag: "vless-reality-8443", Kind: "inbound", TS: now, BytesUp: 100, BytesDown: 200},
	}}
	env, _ := agentapi.Frame(agentapi.TypeXrayTraffic, batch)
	ing.HandleFrame(ctx, sid, env)

	var n int
	_ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM xray_traffic_raw WHERE server_id=?", sid)
	if n != 1 {
		t.Errorf("rows = %d after HandleFrame, want 1", n)
	}
}
