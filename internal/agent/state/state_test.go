package state

import (
	"path/filepath"
	"testing"
)

func TestSaveLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	st := &Store{Path: filepath.Join(dir, "s.json")}
	in := &State{MachineToken: "tok", Fingerprint: "fp", TelemetryIntervalSeconds: 30}
	if err := st.Save(in); err != nil {
		t.Fatal(err)
	}
	out, err := st.Load()
	if err != nil {
		t.Fatal(err)
	}
	if out.MachineToken != "tok" || out.TelemetryIntervalSeconds != 30 {
		t.Fatalf("got %+v", out)
	}
}

func TestLoadMissingFileReturnsEmpty(t *testing.T) {
	st := &Store{Path: filepath.Join(t.TempDir(), "absent.json")}
	out, err := st.Load()
	if err != nil {
		t.Fatal(err)
	}
	if out.MachineToken != "" {
		t.Errorf("expected empty state")
	}
}

func TestStateStore_SandboxRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s := &Store{Path: filepath.Join(dir, "agent.state.json")}
	enabled := true
	in := &State{
		MachineToken: "t",
		Fingerprint:  "f",
		Sandbox:      &SandboxState{Enabled: &enabled, Paths: []string{"/tmp", "/var/log"}},
	}
	if err := s.Save(in); err != nil {
		t.Fatal(err)
	}
	out, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	if out.Sandbox == nil || out.Sandbox.Enabled == nil || !*out.Sandbox.Enabled {
		t.Fatalf("sandbox not persisted: %+v", out.Sandbox)
	}
	if len(out.Sandbox.Paths) != 2 || out.Sandbox.Paths[0] != "/tmp" {
		t.Fatalf("paths=%v", out.Sandbox.Paths)
	}
}
