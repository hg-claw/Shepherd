package singboxsampler

import (
	"testing"
)

// TestParseConnections_AggregatesByTag verifies that upload and download bytes
// are summed per inbound tag across multiple connections.
//
// The metadata.type field is shaped "<inboundType>/<tag>" by sing-box's
// clash-api MarshalJSON — we strip the type prefix to recover the tag.
func TestParseConnections_AggregatesByTag(t *testing.T) {
	raw := []byte(`{
		"connections": [
			{"id":"c1","upload":1024,"download":2048,"metadata":{"type":"vless/landing-aa","network":"tcp"}},
			{"id":"c2","upload":512, "download":1024,"metadata":{"type":"vless/landing-aa","network":"tcp"}},
			{"id":"c3","upload":4096,"download":8192,"metadata":{"type":"trojan/relay-bb","network":"udp"}}
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
	if got["landing-aa"].Up != 1536 {
		t.Errorf("landing-aa up = %d, want 1536 (1024+512)", got["landing-aa"].Up)
	}
	if got["landing-aa"].Down != 3072 {
		t.Errorf("landing-aa down = %d, want 3072 (2048+1024)", got["landing-aa"].Down)
	}
	if got["relay-bb"].Up != 4096 {
		t.Errorf("relay-bb up = %d, want 4096", got["relay-bb"].Up)
	}
	if got["relay-bb"].Down != 8192 {
		t.Errorf("relay-bb down = %d, want 8192", got["relay-bb"].Down)
	}
}

// TestParseConnections_SkipsUntaggedType verifies that connections whose
// metadata.type is just an inbound-type name with no tag (e.g. "anytls" rather
// than "anytls/landing-…") are skipped — they would otherwise be aggregated
// under the bare type, which doesn't match any DB tag.
func TestParseConnections_SkipsUntaggedType(t *testing.T) {
	raw := []byte(`{
		"connections": [
			{"id":"c1","upload":100,"download":200,"metadata":{"network":"tcp"}},
			{"id":"c2","upload":300,"download":400,"metadata":{"type":"anytls","network":"udp"}}
		],
		"uploadTotal":400,"downloadTotal":600
	}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("expected empty map for untagged type, got %d entries: %v", len(got), got)
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
	const fiveGiB = int64(5 * 1024 * 1024 * 1024)
	raw := []byte(`{
		"connections": [
			{"id":"c1","upload":5368709120,"download":5368709120,"metadata":{"type":"vless/landing-big","network":"tcp"}},
			{"id":"c2","upload":5368709120,"download":5368709120,"metadata":{"type":"vless/landing-big","network":"tcp"}}
		],
		"uploadTotal":10737418240,"downloadTotal":10737418240
	}`)
	got, err := ParseConnections(raw)
	if err != nil {
		t.Fatal(err)
	}
	want := fiveGiB * 2
	if got["landing-big"].Up != want {
		t.Errorf("landing-big up = %d, want %d", got["landing-big"].Up, want)
	}
	if got["landing-big"].Down != want {
		t.Errorf("landing-big down = %d, want %d", got["landing-big"].Down, want)
	}
}

// TestInboundTagFromType covers the helper directly to lock in the parsing of
// the "<type>/<tag>" composite produced by sing-box's tracker MarshalJSON.
func TestInboundTagFromType(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"anytls/landing-55ecc720", "landing-55ecc720"},
		{"vless/relay-aabb1122", "relay-aabb1122"},
		{"shadowsocks/landing-xx/with/slashes", "landing-xx/with/slashes"},
		{"anytls", ""},
		{"", ""},
	}
	for _, c := range cases {
		if got := inboundTagFromType(c.in); got != c.want {
			t.Errorf("inboundTagFromType(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
