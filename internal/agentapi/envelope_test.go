package agentapi

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestFrameAndDecode(t *testing.T) {
	src := Telemetry{TS: time.Unix(1700000000, 0).UTC(), CPUPct: 12.5, Disks: []Disk{{Mount: "/", Used: 1, Total: 2}}}
	e, err := Frame(TypeTelemetry, src)
	if err != nil {
		t.Fatal(err)
	}
	if e.Type != TypeTelemetry {
		t.Fatal("bad type")
	}
	var out Telemetry
	if err := e.Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out.CPUPct != 12.5 || len(out.Disks) != 1 {
		t.Fatalf("decode mismatch %+v", out)
	}
}

func TestEnvelope_OmitsEmptySid(t *testing.T) {
	e, _ := Frame("ping", struct{}{})
	b, _ := json.Marshal(e)
	got := string(b)
	if strings.Contains(got, `"sid"`) {
		t.Errorf("unexpected sid in %s", got)
	}
}
