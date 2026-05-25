package agentapi

import (
	"encoding/json"
	"strings"
	"testing"
)

// Regression: the LogVerbose pointer must survive the Frame → wire-JSON
// → Decode round-trip with the value preserved. A naive value-typed
// field would lose "explicit false" vs "omitted", which the agent uses
// to distinguish "no change" from "turn off". An end-to-end check
// catches the case where someone changes the field type or json tag.
func TestConfigUpdateWireRoundTrip_LogVerbose(t *testing.T) {
	cases := []struct {
		name string
		in   *bool
	}{
		{"omitted", nil},
		{"true", boolPtr(true)},
		{"false", boolPtr(false)},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			env, err := Frame(TypeConfigUpdate, ConfigUpdate{LogVerbose: c.in})
			if err != nil {
				t.Fatalf("Frame: %v", err)
			}
			wire, _ := json.Marshal(env)
			if c.in == nil && strings.Contains(string(wire), "log_verbose") {
				t.Errorf("nil LogVerbose should be omitted; wire = %s", wire)
			}
			if c.in != nil && !strings.Contains(string(wire), "log_verbose") {
				t.Errorf("non-nil LogVerbose should appear on wire; wire = %s", wire)
			}

			var back Envelope
			if err := json.Unmarshal(wire, &back); err != nil {
				t.Fatalf("Unmarshal envelope: %v", err)
			}
			var u ConfigUpdate
			if err := back.Decode(&u); err != nil {
				t.Fatalf("Decode: %v", err)
			}
			switch {
			case c.in == nil && u.LogVerbose != nil:
				t.Errorf("after round-trip, LogVerbose = %v, want nil", *u.LogVerbose)
			case c.in != nil && u.LogVerbose == nil:
				t.Errorf("after round-trip, LogVerbose = nil, want *%v", *c.in)
			case c.in != nil && *u.LogVerbose != *c.in:
				t.Errorf("after round-trip, LogVerbose = %v, want %v", *u.LogVerbose, *c.in)
			}
		})
	}
}

func boolPtr(b bool) *bool { return &b }
