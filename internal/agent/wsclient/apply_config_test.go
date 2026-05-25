package wsclient

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agent/state"
	"github.com/hg-claw/Shepherd/internal/agent/vlog"
	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// applyConfig must flip the vlog gate when the server pushes
// ConfigUpdate{LogVerbose: &true} — this is the load-bearing path
// behind the "Agent verbose log" admin toggle.
func TestApplyConfig_TogglesVlog(t *testing.T) {
	t.Cleanup(func() { vlog.SetEnabled(false) })
	vlog.SetEnabled(false) // start clean — vlog is a process-wide global

	c := &Client{
		State: &state.Store{Path: filepath.Join(t.TempDir(), "agent-state.json")},
	}
	// fh is only read on the sandbox branch; LogVerbose path doesn't
	// touch it, so nil is OK.
	on := true
	cu := agentapi.ConfigUpdate{LogVerbose: &on}
	raw, _ := json.Marshal(cu)
	env := agentapi.Envelope{Type: agentapi.TypeConfigUpdate, P: raw}
	c.applyConfig(env, nil)
	if !vlog.Enabled() {
		t.Fatal("vlog still off after applyConfig(LogVerbose=true)")
	}

	off := false
	cu = agentapi.ConfigUpdate{LogVerbose: &off}
	raw, _ = json.Marshal(cu)
	env = agentapi.Envelope{Type: agentapi.TypeConfigUpdate, P: raw}
	c.applyConfig(env, nil)
	if vlog.Enabled() {
		t.Fatal("vlog still on after applyConfig(LogVerbose=false)")
	}
}

// A ConfigUpdate that omits LogVerbose must leave the existing vlog
// state untouched (omitted ≠ false). This is the path hit on telemetry-
// interval pushes that don't carry the verbose field.
func TestApplyConfig_OmittedLogVerboseLeavesGateAlone(t *testing.T) {
	t.Cleanup(func() { vlog.SetEnabled(false) })
	vlog.SetEnabled(true)

	c := &Client{
		State: &state.Store{Path: filepath.Join(t.TempDir(), "agent-state.json")},
	}
	cu := agentapi.ConfigUpdate{TelemetryIntervalSeconds: 30}
	raw, _ := json.Marshal(cu)
	env := agentapi.Envelope{Type: agentapi.TypeConfigUpdate, P: raw}
	c.applyConfig(env, nil)
	if !vlog.Enabled() {
		t.Fatal("ConfigUpdate without LogVerbose disabled vlog; should be a no-op")
	}
}
