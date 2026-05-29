package telemetrysvc

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newIngest(t *testing.T) (*Ingest, int64) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
	id, _ := res.LastInsertId()
	return &Ingest{DB: d}, id
}

func heartbeatFrame(t *testing.T, hb agentapi.Heartbeat) agentapi.Envelope {
	t.Helper()
	env, err := agentapi.Frame(agentapi.TypeHeartbeat, hb)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

// TestHandleFrame_HeartbeatIPCandidates verifies that a heartbeat carrying
// IPCandidates upserts into server_ip_candidates and auto-sets ssh_host.
func TestHandleFrame_HeartbeatIPCandidates(t *testing.T) {
	ing, sid := newIngest(t)
	ctx := context.Background()

	env := heartbeatFrame(t, agentapi.Heartbeat{
		TS:           time.Now().UTC(),
		AgentVersion: "1.0",
		OS:           "linux",
		Arch:         "amd64",
		Kernel:       "6.0",
		IPCandidates: []agentapi.IPCandidate{
			{Addr: "203.0.113.1", Kind: "public", Source: "eth0"},
			{Addr: "192.168.1.5", Kind: "private", Source: "eth1"},
		},
	})
	ing.HandleFrame(ctx, sid, env)

	// Both candidates must appear in server_ip_candidates.
	var n int
	if err := ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM server_ip_candidates WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("expected 2 ip candidates, got %d", n)
	}

	// The public IP should have been chosen as ssh_host (was empty before).
	var sshHost sql.NullString
	if err := ing.DB.GetContext(ctx, &sshHost, "SELECT ssh_host FROM servers WHERE id=?", sid); err != nil {
		t.Fatal(err)
	}
	if !sshHost.Valid || sshHost.String != "203.0.113.1" {
		t.Fatalf("expected ssh_host=203.0.113.1, got %v", sshHost)
	}
}

// TestHandleFrame_HeartbeatNoCandidates verifies that a heartbeat with no
// IPCandidates does not touch server_ip_candidates or ssh_host.
func TestHandleFrame_HeartbeatNoCandidates(t *testing.T) {
	ing, sid := newIngest(t)
	ctx := context.Background()

	// Seed a known ssh_host value.
	if _, err := ing.DB.ExecContext(ctx, "UPDATE servers SET ssh_host='10.0.0.1' WHERE id=?", sid); err != nil {
		t.Fatal(err)
	}

	// First heartbeat with candidates to populate the table.
	ing.HandleFrame(ctx, sid, heartbeatFrame(t, agentapi.Heartbeat{
		TS:           time.Now().UTC(),
		AgentVersion: "1.0",
		IPCandidates: []agentapi.IPCandidate{
			{Addr: "203.0.113.2", Kind: "public", Source: "eth0"},
		},
	}))

	// Second heartbeat without candidates — must not change ssh_host or add rows.
	ing.HandleFrame(ctx, sid, heartbeatFrame(t, agentapi.Heartbeat{
		TS:           time.Now().UTC(),
		AgentVersion: "1.0",
	}))

	var sshHost sql.NullString
	if err := ing.DB.GetContext(ctx, &sshHost, "SELECT ssh_host FROM servers WHERE id=?", sid); err != nil {
		t.Fatal(err)
	}
	// ssh_host should still be admin-set value (10.0.0.1), not overwritten.
	if !sshHost.Valid || sshHost.String != "10.0.0.1" {
		t.Fatalf("expected ssh_host=10.0.0.1 (unchanged), got %v", sshHost)
	}
}

func TestWriteSample_PersistsAndBumpsLastSeen(t *testing.T) {
	ing, sid := newIngest(t)
	now := time.Now().UTC().Truncate(time.Second)
	tt := agentapi.Telemetry{
		TS: now, CPUPct: 12.5, MemUsed: 1, MemTotal: 2, Load1: 0.1,
		NetRxBps: 100, NetTxBps: 200, TCPConn: 7,
		Disks: []agentapi.Disk{{Mount: "/", Used: 10, Total: 100}},
	}
	if err := ing.WriteSample(context.Background(), sid, tt); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := ing.DB.Get(&n, "SELECT COUNT(*) FROM telemetry_samples_30s WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("rows=%d", n)
	}
	var seen time.Time
	if err := ing.DB.Get(&seen, "SELECT agent_last_seen FROM servers WHERE id=?", sid); err != nil {
		t.Fatal(err)
	}
	if seen.IsZero() {
		t.Error("agent_last_seen not bumped")
	}
}

// TestWriteSample_LastSeenUsesServerClock guards the agent/server clock-skew
// bug: liveness must be measured by the server's receipt time, never the
// agent-supplied Telemetry.TS. A telemetry sample carrying a TS far in the past
// (a behind/mis-NTP'd agent clock) must still bump agent_last_seen to ~now, so
// the public wall's `time.Since(agent_last_seen)` freshness check stays accurate
// while the agent is actively reporting.
func TestWriteSample_LastSeenUsesServerClock(t *testing.T) {
	ing, sid := newIngest(t)
	// Agent clock lags the server by 10 minutes.
	staleTS := time.Now().UTC().Add(-10 * time.Minute)
	tt := agentapi.Telemetry{TS: staleTS, CPUPct: 1, MemUsed: 1, MemTotal: 2}
	if err := ing.WriteSample(context.Background(), sid, tt); err != nil {
		t.Fatal(err)
	}
	var seen time.Time
	if err := ing.DB.Get(&seen, "SELECT agent_last_seen FROM servers WHERE id=?", sid); err != nil {
		t.Fatal(err)
	}
	// Must reflect server receipt time (~now), NOT the stale agent TS.
	if d := time.Since(seen); d > time.Minute {
		t.Fatalf("agent_last_seen is %v old — bumped with agent clock, not server clock (skew bug)", d)
	}
	// And the time-series sample keeps the agent's measurement timestamp.
	var sampleTS time.Time
	if err := ing.DB.Get(&sampleTS, "SELECT ts FROM telemetry_samples_30s WHERE server_id=?", sid); err != nil {
		t.Fatal(err)
	}
	if sampleTS.UTC().Sub(staleTS).Abs() > 2*time.Second {
		t.Fatalf("sample ts should keep the agent TS %v, got %v", staleTS, sampleTS)
	}
}
