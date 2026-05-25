package serversvc

import (
	"context"
	"testing"
)

// SandboxPusher.Snapshot must surface agent_log_verbose so a settings
// flip fans out to online agents via ConfigUpdate. Defaults to false
// when the row is absent (fresh install / pre-Phase-4 migration).
func TestSandboxPusher_Snapshot_IncludesLogVerbose(t *testing.T) {
	s := newSettings(t)
	p := &SandboxPusher{Settings: s} // Hub nil — Snapshot doesn't touch it.
	ctx := context.Background()

	cu := p.Snapshot(ctx)
	if cu.LogVerbose == nil {
		t.Fatal("Snapshot returned nil LogVerbose; want explicit *false on fresh DB")
	}
	if *cu.LogVerbose {
		t.Errorf("default LogVerbose = true, want false")
	}

	if err := s.Set(ctx, "agent_log_verbose", "true"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	cu = p.Snapshot(ctx)
	if cu.LogVerbose == nil || !*cu.LogVerbose {
		t.Errorf("after Set true, LogVerbose = %v, want *true", cu.LogVerbose)
	}
}
