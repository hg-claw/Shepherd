package xraysampler

import (
	"os"
	"testing"
)

// helpers

func mustEntry(t *testing.T, got []StatEntry, kind, tag, direction string) int64 {
	t.Helper()
	for _, e := range got {
		if e.Kind == kind && e.Tag == tag && e.Direction == direction {
			return e.Value
		}
	}
	t.Errorf("entry not found: kind=%q tag=%q direction=%q", kind, tag, direction)
	return -1
}

// V1.8 plain-text format tests

func TestParseStats_V18Format(t *testing.T) {
	data, err := os.ReadFile("testdata/v18_output.txt")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseStats(data)
	if err != nil {
		t.Fatal(err)
	}

	if v := mustEntry(t, got, "inbound", "vless-reality-8443", "uplink"); v != 1234567 {
		t.Errorf("inbound uplink = %d, want 1234567", v)
	}
	if v := mustEntry(t, got, "inbound", "vless-reality-8443", "downlink"); v != 7654321 {
		t.Errorf("inbound downlink = %d, want 7654321", v)
	}
	if v := mustEntry(t, got, "outbound", "direct", "uplink"); v != 111111 {
		t.Errorf("outbound uplink = %d, want 111111", v)
	}
	if v := mustEntry(t, got, "outbound", "direct", "downlink"); v != 9876543 {
		t.Errorf("outbound downlink = %d, want 9876543", v)
	}
}

func TestParseStats_V18SkipsUserCounters(t *testing.T) {
	data, err := os.ReadFile("testdata/v18_output.txt")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseStats(data)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range got {
		if e.Kind == "user" {
			t.Errorf("user>>> counter should be filtered out, got %+v", e)
		}
	}
}

func TestParseStats_V18ExactCount(t *testing.T) {
	data, err := os.ReadFile("testdata/v18_output.txt")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseStats(data)
	if err != nil {
		t.Fatal(err)
	}
	// 4 valid entries (2 inbound + 2 outbound); user>>> filtered out
	if len(got) != 4 {
		t.Errorf("len = %d, want 4", len(got))
	}
}

// V1.9 JSON object format tests

func TestParseStats_V19Format(t *testing.T) {
	data, err := os.ReadFile("testdata/v19_output.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseStats(data)
	if err != nil {
		t.Fatal(err)
	}

	if v := mustEntry(t, got, "inbound", "vmess-ws-443", "uplink"); v != 123000 {
		t.Errorf("inbound uplink = %d, want 123000", v)
	}
	if v := mustEntry(t, got, "inbound", "vmess-ws-443", "downlink"); v != 555000 {
		t.Errorf("inbound downlink = %d, want 555000", v)
	}
	if v := mustEntry(t, got, "outbound", "direct", "uplink"); v != 99000 {
		t.Errorf("outbound uplink = %d, want 99000", v)
	}
	if v := mustEntry(t, got, "outbound", "direct", "downlink"); v != 44000 {
		t.Errorf("outbound downlink = %d, want 44000", v)
	}
}

func TestParseStats_V19SkipsUserCounters(t *testing.T) {
	data, err := os.ReadFile("testdata/v19_output.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseStats(data)
	if err != nil {
		t.Fatal(err)
	}
	// 4 valid entries; user>>> filtered out
	if len(got) != 4 {
		t.Errorf("len = %d, want 4", len(got))
	}
}

// Edge-case tests using inline literals

func TestParseStats_SkipsShepherdInternalTag(t *testing.T) {
	// v1.9 JSON with shepherd-internal inbound tag
	raw := []byte(`{"stat":[{"name":"inbound>>>__shepherd_api__>>>traffic>>>uplink","value":"100"}]}`)
	got, err := ParseStats(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 entries (shepherd-internal filtered), got %d", len(got))
	}
}

func TestParseStats_InvalidNameSkipped(t *testing.T) {
	raw := []byte(`{"stat":[{"name":"not-valid-format","value":"1"}]}`)
	got, err := ParseStats(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 entries for invalid name, got %d", len(got))
	}
}

func TestParseStats_EmptyV19(t *testing.T) {
	got, err := ParseStats([]byte(`{"stat":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 entries, got %d", len(got))
	}
}

func TestParseStats_EmptyV18Text(t *testing.T) {
	got, err := ParseStats([]byte(``))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected 0 entries, got %d", len(got))
	}
}

func TestParseStats_V18InlineBasic(t *testing.T) {
	raw := []byte("inbound>>>landing-aa>>>traffic>>>uplink:    1234567\n" +
		"inbound>>>landing-aa>>>traffic>>>downlink:  9876543\n" +
		"outbound>>>to-landing-bb>>>traffic>>>uplink:  234567\n")
	got, err := ParseStats(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Errorf("len = %d, want 3", len(got))
	}
	if v := mustEntry(t, got, "inbound", "landing-aa", "uplink"); v != 1234567 {
		t.Errorf("got %d, want 1234567", v)
	}
}

func TestParseStats_V19NumericValue(t *testing.T) {
	// Some implementations may emit numeric (not string) values; handle both.
	raw := []byte(`{"stat":[{"name":"inbound>>>tag1>>>traffic>>>uplink","value":42}]}`)
	got, err := ParseStats(raw)
	if err != nil {
		t.Fatal(err)
	}
	if v := mustEntry(t, got, "inbound", "tag1", "uplink"); v != 42 {
		t.Errorf("got %d, want 42", v)
	}
}
