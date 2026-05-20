package agentapi

import (
	"testing"
	"time"
)

func TestXrayTrafficBatch_RoundTrip(t *testing.T) {
	batch := XrayTrafficBatch{
		Samples: []XrayTrafficSample{
			{Tag: "vless-reality-8443", Kind: "inbound", TS: time.Date(2026, 5, 19, 10, 0, 30, 0, time.UTC), BytesUp: 102400, BytesDown: 512000},
			{Tag: "direct", Kind: "outbound", TS: time.Date(2026, 5, 19, 10, 0, 30, 0, time.UTC), BytesUp: 89000, BytesDown: 0},
		},
	}
	env, err := Frame(TypeXrayTraffic, batch)
	if err != nil {
		t.Fatal(err)
	}
	if env.Type != TypeXrayTraffic {
		t.Errorf("type = %q, want %q", env.Type, TypeXrayTraffic)
	}
	var got XrayTrafficBatch
	if err := env.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(got.Samples))
	}
	if got.Samples[0].BytesUp != 102400 {
		t.Errorf("BytesUp = %d, want 102400", got.Samples[0].BytesUp)
	}
}

func TestSingboxTrafficBatch_RoundTrip(t *testing.T) {
	batch := SingboxTrafficBatch{
		Samples: []SingboxTrafficSample{
			{Tag: "landing-aabb1122", Kind: "landing", TS: time.Date(2026, 5, 20, 10, 0, 30, 0, time.UTC), BytesUp: 204800, BytesDown: 1048576},
			{Tag: "relay-ccdd3344", Kind: "relay", TS: time.Date(2026, 5, 20, 10, 0, 30, 0, time.UTC), BytesUp: 1024, BytesDown: 512},
		},
	}
	env, err := Frame(TypeSingboxTraffic, batch)
	if err != nil {
		t.Fatal(err)
	}
	if env.Type != TypeSingboxTraffic {
		t.Errorf("type = %q, want %q", env.Type, TypeSingboxTraffic)
	}
	var got SingboxTrafficBatch
	if err := env.Decode(&got); err != nil {
		t.Fatal(err)
	}
	if len(got.Samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(got.Samples))
	}
	if got.Samples[0].BytesUp != 204800 {
		t.Errorf("BytesUp = %d, want 204800", got.Samples[0].BytesUp)
	}
}
