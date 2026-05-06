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
