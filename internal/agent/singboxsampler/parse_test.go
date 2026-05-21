package singboxsampler

import (
	"testing"
)

// TestParseConnections_AggregatesByTag verifies that upload and download bytes
// are summed per inbound tag across multiple connections.
func TestParseConnections_AggregatesByTag(t *testing.T) {
	raw := []byte(`{
		"connections": [
			{"id":"c1","upload":1024,"download":2048,"metadata":{"inbound":"vless-aa","network":"tcp"}},
			{"id":"c2","upload":512, "download":1024,"metadata":{"inbound":"vless-aa","network":"tcp"}},
			{"id":"c3","upload":4096,"download":8192,"metadata":{"inbound":"trojan-bb","network":"udp"}}
		],
		"uploadTotal":5632,"downloadTotal":11264
	}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("len = %d, want 2", len(got))
	}
	if got["vless-aa"].Up != 1536 {
		t.Errorf("vless-aa up = %d, want 1536 (1024+512)", got["vless-aa"].Up)
	}
	if got["vless-aa"].Down != 3072 {
		t.Errorf("vless-aa down = %d, want 3072 (2048+1024)", got["vless-aa"].Down)
	}
	if got["trojan-bb"].Up != 4096 {
		t.Errorf("trojan-bb up = %d, want 4096", got["trojan-bb"].Up)
	}
	if got["trojan-bb"].Down != 8192 {
		t.Errorf("trojan-bb down = %d, want 8192", got["trojan-bb"].Down)
	}
}

// TestParseConnections_SkipsMissingInbound verifies that connections with an
// empty or absent metadata.inbound field are skipped defensively.
func TestParseConnections_SkipsMissingInbound(t *testing.T) {
	raw := []byte(`{
		"connections": [
			{"id":"c1","upload":100,"download":200,"metadata":{"network":"tcp"}},
			{"id":"c2","upload":300,"download":400,"metadata":{"inbound":"","network":"udp"}}
		],
		"uploadTotal":400,"downloadTotal":600
	}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty map for missing inbound, got %d entries", len(got))
	}
}

// TestParseConnections_EmptyConnections verifies that an empty connections list
// returns an empty (non-nil) map without error.
func TestParseConnections_EmptyConnections(t *testing.T) {
	raw := []byte(`{"connections":[],"uploadTotal":0,"downloadTotal":0}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	if got == nil {
		t.Error("expected non-nil map, got nil")
	}
	if len(got) != 0 {
		t.Errorf("expected empty map, got %d entries", len(got))
	}
}

// TestParseConnections_BadJSON verifies that malformed JSON input returns an error.
func TestParseConnections_BadJSON(t *testing.T) {
	_, err := ParseConnections([]byte(`not-json`))
	if err == nil {
		t.Error("expected error for malformed JSON, got nil")
	}
}

// TestParseConnections_LargeValues verifies that upload/download values larger
// than 2^32 (uint32 max) are handled correctly as int64.
func TestParseConnections_LargeValues(t *testing.T) {
	// 5 GiB per connection — well above uint32 max (4294967295).
	const fiveGiB = int64(5 * 1024 * 1024 * 1024) // 5368709120
	raw := []byte(`{
		"connections": [
			{"id":"c1","upload":5368709120,"download":5368709120,"metadata":{"inbound":"big-pipe","network":"tcp"}},
			{"id":"c2","upload":5368709120,"download":5368709120,"metadata":{"inbound":"big-pipe","network":"tcp"}}
		],
		"uploadTotal":10737418240,"downloadTotal":10737418240
	}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := fiveGiB * 2
	if got["big-pipe"].Up != want {
		t.Errorf("big-pipe up = %d, want %d", got["big-pipe"].Up, want)
	}
	if got["big-pipe"].Down != want {
		t.Errorf("big-pipe down = %d, want %d", got["big-pipe"].Down, want)
	}
}
