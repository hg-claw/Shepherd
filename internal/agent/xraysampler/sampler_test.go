package xraysampler

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// Pretend the xray plugin binary is installed in every test by default.
// TestSkipsWhenPluginAbsent re-flips this locally to verify the guard.
func init() { pluginInstalledFn = func() bool { return true } }

func TestSkipsWhenPluginAbsent(t *testing.T) {
	orig := pluginInstalledFn
	pluginInstalledFn = func() bool { return false }
	t.Cleanup(func() { pluginInstalledFn = orig })

	sent := 0
	queryCalled := false
	s := &Sampler{
		Send:      func(_ agentapi.Envelope) error { sent++; return nil },
		queryFunc: func(_ string) (map[statKey]int64, error) {
			queryCalled = true
			return map[statKey]int64{}, nil
		},
	}
	s.tick(context.Background())
	if queryCalled {
		t.Error("query should not run when plugin is absent")
	}
	if sent != 0 {
		t.Errorf("expected 0 sends when plugin absent, got %d", sent)
	}
}

// fakeQuery returns a queryFunc that always returns the given map.
func fakeQuery(m map[statKey]int64) func(address string) (map[statKey]int64, error) {
	return func(_ string) (map[statKey]int64, error) { return m, nil }
}

// fakeErr returns a queryFunc that always returns the given error.
func fakeErr(err error) func(address string) (map[statKey]int64, error) {
	return func(_ string) (map[statKey]int64, error) { return nil, err }
}

// runTicks drives the sampler through a sequence of query results and collects sent batches.
func runTicks(s *Sampler, queries []map[statKey]int64) []agentapi.XrayTrafficBatch {
	var sent []agentapi.XrayTrafficBatch
	s.Send = func(env agentapi.Envelope) error {
		var b agentapi.XrayTrafficBatch
		_ = env.Decode(&b)
		sent = append(sent, b)
		return nil
	}
	for _, q := range queries {
		s.queryFunc = fakeQuery(q)
		s.tick(context.Background())
	}
	return sent
}

// TestFirstTickNoReport verifies that the first tick stores a baseline but does not send.
func TestFirstTickNoReport(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	key := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
	sent := runTicks(s, []map[statKey]int64{{key: 1000}})
	if len(sent) != 0 {
		t.Errorf("first tick should not send; got %d batches", len(sent))
	}
}

// TestSecondTickDelta verifies delta computation from tick 1→2.
func TestSecondTickDelta(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	ku := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
	kd := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "down"}
	sent := runTicks(s, []map[statKey]int64{
		{ku: 1000, kd: 5000},
		{ku: 1500, kd: 8000},
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch after second tick, got %d", len(sent))
	}
	if len(sent[0].Samples) != 1 {
		t.Fatalf("expected 1 sample (one tag), got %d", len(sent[0].Samples))
	}
	sample := sent[0].Samples[0]
	if sample.BytesUp != 500 {
		t.Errorf("BytesUp = %d, want 500", sample.BytesUp)
	}
	if sample.BytesDown != 3000 {
		t.Errorf("BytesDown = %d, want 3000", sample.BytesDown)
	}
}

// TestThirdTickAccumulates verifies cumulative delta over three ticks.
func TestThirdTickAccumulates(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	ku := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
	sent := runTicks(s, []map[statKey]int64{
		{ku: 1000},
		{ku: 1500}, // Δ=500
		{ku: 1800}, // Δ=300
	})
	if len(sent) != 2 {
		t.Fatalf("expected 2 batches (ticks 2 and 3), got %d", len(sent))
	}
	if sent[1].Samples[0].BytesUp != 300 {
		t.Errorf("tick3 BytesUp = %d, want 300", sent[1].Samples[0].BytesUp)
	}
}

// TestXrayRestartZeroDelta verifies that a counter reset (current < previous) emits 0, not negative.
func TestXrayRestartZeroDelta(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	ku := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
	sent := runTicks(s, []map[statKey]int64{
		{ku: 5000},
		{ku: 200}, // xray restart: counter went backwards
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch, got %d", len(sent))
	}
	if sent[0].Samples[0].BytesUp != 0 {
		t.Errorf("BytesUp = %d after restart, want 0", sent[0].Samples[0].BytesUp)
	}
}

// TestUplinkOnlyNilDownlink verifies that a tag with only uplink data emits BytesDown=0.
func TestUplinkOnlyNilDownlink(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	ku := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
	// No "down" key at all.
	sent := runTicks(s, []map[statKey]int64{
		{ku: 1000},
		{ku: 2000},
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch, got %d", len(sent))
	}
	sample := sent[0].Samples[0]
	if sample.BytesUp != 1000 {
		t.Errorf("BytesUp = %d, want 1000", sample.BytesUp)
	}
	if sample.BytesDown != 0 {
		t.Errorf("BytesDown = %d, want 0", sample.BytesDown)
	}
}

// TestSocketMissingSkip verifies that a query error suppresses send without panicking.
func TestSocketMissingSkip(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	var sendCalled bool
	s.Send = func(_ agentapi.Envelope) error { sendCalled = true; return nil }
	s.queryFunc = fakeErr(fmt.Errorf("socket not found"))
	s.tick(context.Background())
	if sendCalled {
		t.Error("Send should not be called when query fails")
	}
}

// TestAllZeroDeltaStillSends verifies that an all-zero delta still emits a batch.
func TestAllZeroDeltaStillSends(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	ku := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
	sent := runTicks(s, []map[statKey]int64{
		{ku: 1000},
		{ku: 1000}, // no change — delta = 0
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch even for zero delta, got %d", len(sent))
	}
	if sent[0].Samples[0].BytesUp != 0 {
		t.Errorf("BytesUp = %d, want 0", sent[0].Samples[0].BytesUp)
	}
}

// TestSendErrorContinues verifies that Send returning an error does not panic or stop the loop.
func TestSendErrorContinues(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:0", Interval: time.Second}
	ku := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
	callCount := 0
	s.Send = func(_ agentapi.Envelope) error {
		callCount++
		return fmt.Errorf("network error")
	}
	// Run 3 ticks: tick1=baseline, tick2=error send, tick3=error send again.
	for _, v := range []int64{1000, 1500, 2000} {
		s.queryFunc = fakeQuery(map[statKey]int64{ku: v})
		s.tick(context.Background())
	}
	// Ticks 2 and 3 should both attempt send (even if they error).
	if callCount != 2 {
		t.Errorf("Send called %d times, want 2", callCount)
	}
}
