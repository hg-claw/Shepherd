package telemetrysvc

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	nqplugin "github.com/hg-claw/Shepherd/internal/plugins/netquality"
)

// newIngestWithNetquality reuses the singbox-traffic helper newIngest +
// applies the netquality plugin's schema, then seeds one target + one
// host so FKs on the sample insert resolve.
func newIngestWithNetquality(t *testing.T) (*Ingest, int64, int64) {
	t.Helper()
	ing, sid := newIngest(t)
	ctx := context.Background()
	if err := plugins.RunPluginMigrations(ctx, ing.DB, "netquality",
		nqplugin.Migrations(shepdb.DriverSQLite)); err != nil {
		t.Fatal(err)
	}
	// one target + the netquality_hosts row WriteNetqualityBatch
	// updates as part of its transaction.
	res, err := ing.DB.ExecContext(ctx, `
		INSERT INTO netquality_targets
		  (source, isp, region, label, host, enabled, created_at)
		VALUES ('builtin','overseas','Global','Test 1.1.1.1','1.1.1.1', 1, $1)`,
		time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	tid, _ := res.LastInsertId()
	if _, err := ing.DB.ExecContext(ctx, `
		INSERT INTO netquality_hosts (server_id, enabled, sample_interval_seconds, updated_at)
		VALUES ($1, 1, 300, $2)`,
		sid, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	return ing, sid, tid
}

func TestWriteNetqualityBatch_OKSampleLandsWithRTT(t *testing.T) {
	ing, sid, tid := newIngestWithNetquality(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)

	avg, jit := 12.34, 0.45
	if err := ing.WriteNetqualityBatch(ctx, sid, []agentapi.NetqualitySample{
		{TargetID: tid, TS: now, Status: "ok", LossPct: 0, RTTAvgMs: &avg, JitterMs: &jit},
	}); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Status   string  `db:"status"`
		LossPct  float64 `db:"loss_pct"`
		RTTAvgMs float64 `db:"rtt_avg_ms"`
	}
	if err := ing.DB.GetContext(ctx, &got,
		`SELECT status, loss_pct, rtt_avg_ms FROM netquality_samples_raw
		 WHERE server_id=? AND target_id=?`, sid, tid); err != nil {
		t.Fatal(err)
	}
	if got.Status != "ok" || got.RTTAvgMs != 12.34 || got.LossPct != 0 {
		t.Errorf("got=%+v", got)
	}
}

func TestWriteNetqualityBatch_LostSampleHasNullRTT(t *testing.T) {
	// Status=lost samples MUST land with NULL rtt_avg_ms so AVG() in the
	// rollup ignores them — otherwise a lost minute would average to 0
	// and dashboards would mistake outages for instant responses.
	ing, sid, tid := newIngestWithNetquality(t)
	ctx := context.Background()

	if err := ing.WriteNetqualityBatch(ctx, sid, []agentapi.NetqualitySample{
		{TargetID: tid, TS: time.Now().UTC(), Status: "lost", LossPct: 100},
	}); err != nil {
		t.Fatal(err)
	}
	var rttIsNull bool
	_ = ing.DB.GetContext(ctx, &rttIsNull,
		`SELECT rtt_avg_ms IS NULL FROM netquality_samples_raw
		 WHERE server_id=? AND target_id=?`, sid, tid)
	if !rttIsNull {
		t.Error("lost sample stored a non-NULL rtt_avg_ms")
	}
}

func TestWriteNetqualityBatch_ClearsLastError(t *testing.T) {
	// Once a batch successfully lands, the host's last_error column
	// must be cleared so the admin UI flips back to healthy without
	// waiting for the operator to retry whatever set it.
	ing, sid, tid := newIngestWithNetquality(t)
	ctx := context.Background()

	if _, err := ing.DB.ExecContext(ctx,
		`UPDATE netquality_hosts SET last_error='stale failure' WHERE server_id=?`, sid); err != nil {
		t.Fatal(err)
	}
	if err := ing.WriteNetqualityBatch(ctx, sid, []agentapi.NetqualitySample{
		{TargetID: tid, TS: time.Now().UTC(), Status: "ok", LossPct: 0},
	}); err != nil {
		t.Fatal(err)
	}
	var le *string
	_ = ing.DB.GetContext(ctx, &le,
		`SELECT last_error FROM netquality_hosts WHERE server_id=?`, sid)
	if le != nil {
		t.Errorf("last_error not cleared: %q", *le)
	}
}

func TestHandleFrame_NetqualityBatch(t *testing.T) {
	ing, sid, tid := newIngestWithNetquality(t)
	env, _ := agentapi.Frame(agentapi.TypeNetqualityBatch, agentapi.NetqualityBatch{
		Samples: []agentapi.NetqualitySample{
			{TargetID: tid, TS: time.Now().UTC(), Status: "ok", LossPct: 0},
		},
	})
	ing.HandleFrame(context.Background(), sid, env)

	var n int
	_ = ing.DB.Get(&n, `SELECT COUNT(*) FROM netquality_samples_raw WHERE server_id=?`, sid)
	if n != 1 {
		t.Errorf("rows after HandleFrame = %d, want 1", n)
	}
}
