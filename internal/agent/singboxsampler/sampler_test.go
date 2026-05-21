package singboxsampler

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// Pretend the singbox plugin binary is installed in every test by default.
// TestSkipsWhenPluginAbsent re-flips this locally to verify the guard.
func init() { pluginInstalledFn = func() bool { return true } }

func TestSkipsWhenPluginAbsent(t *testing.T) {
	orig := pluginInstalledFn
	pluginInstalledFn = func() bool { return false }
	t.Cleanup(func() { pluginInstalledFn = orig })

	sent := 0
	fetchCalled := false
	s := &Sampler{
		Send: func(_ agentapi.Envelope) error { sent++; return nil },
		fetchFunc: func(_, _ string) (ConnSnapshot, error) {
			fetchCalled = true
			return ConnSnapshot{}, nil
		},
	}
	s.tick(context.Background())
	if fetchCalled {
		t.Error("fetch should not run when plugin is absent")
	}
	if sent != 0 {
		t.Errorf("expected 0 sends when plugin absent, got %d", sent)
	}
}

// runTicks drives the sampler through a sequence of snapshots and collects sent batches.
// Each snapshot is fed to the sampler via a fresh fetchFunc before calling tick.
func runTicks(s *Sampler, snapshots []ConnSnapshot) []agentapi.SingboxTrafficBatch {
	var sent []agentapi.SingboxTrafficBatch
	s.Send = func(env agentapi.Envelope) error {
		var b agentapi.SingboxTrafficBatch
		_ = env.Decode(&b)
		sent = append(sent, b)
		return nil
	}
	for _, snap := range snapshots {
		snap := snap // capture
		s.fetchFunc = func(_, _ string) (ConnSnapshot, error) { return snap, nil }
		s.tick(context.Background())
	}
	return sent
}

// TestSampler_FirstTickNoEmit verifies that the first tick stores a baseline and emits nothing.
func TestSampler_FirstTickNoEmit(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	sent := runTicks(s, []ConnSnapshot{
		{"landing-aabb1122": {Up: 1000, Down: 2000}},
	})
	if len(sent) != 0 {
		t.Errorf("first tick must not send; got %d batches", len(sent))
	}
}

// TestSampler_SecondTickEmitsDelta verifies delta computation from tick 1→2.
func TestSampler_SecondTickEmitsDelta(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	sent := runTicks(s, []ConnSnapshot{
		{"landing-aabb1122": {Up: 1000, Down: 2000}},
		{"landing-aabb1122": {Up: 1500, Down: 3500}},
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch after second tick, got %d", len(sent))
	}
	if len(sent[0].Samples) != 1 {
		t.Fatalf("expected 1 sample, got %d", len(sent[0].Samples))
	}
	s0 := sent[0].Samples[0]
	if s0.BytesUp != 500 {
		t.Errorf("BytesUp = %d, want 500", s0.BytesUp)
	}
	if s0.BytesDown != 1500 {
		t.Errorf("BytesDown = %d, want 1500", s0.BytesDown)
	}
	if s0.Kind != "landing" {
		t.Errorf("Kind = %q, want 'landing'", s0.Kind)
	}
	if s0.Tag != "landing-aabb1122" {
		t.Errorf("Tag = %q, want 'landing-aabb1122'", s0.Tag)
	}
}

// TestSampler_ThirdTickAccumulates verifies that each tick independently computes deltas vs prev.
func TestSampler_ThirdTickAccumulates(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	sent := runTicks(s, []ConnSnapshot{
		{"landing-aabb1122": {Up: 1000, Down: 5000}},
		{"landing-aabb1122": {Up: 1500, Down: 6000}}, // Δup=500, Δdown=1000
		{"landing-aabb1122": {Up: 1800, Down: 6500}}, // Δup=300, Δdown=500
	})
	if len(sent) != 2 {
		t.Fatalf("expected 2 batches (ticks 2 and 3), got %d", len(sent))
	}
	if sent[0].Samples[0].BytesUp != 500 {
		t.Errorf("tick2 BytesUp = %d, want 500", sent[0].Samples[0].BytesUp)
	}
	if sent[1].Samples[0].BytesUp != 300 {
		t.Errorf("tick3 BytesUp = %d, want 300", sent[1].Samples[0].BytesUp)
	}
	if sent[1].Samples[0].BytesDown != 500 {
		t.Errorf("tick3 BytesDown = %d, want 500", sent[1].Samples[0].BytesDown)
	}
}

// TestSampler_CounterResetClampedToZero verifies that a counter decrease emits 0, not negative.
// In sing-box, aggregate tag bytes can decrease when high-traffic connections close.
// We cannot distinguish this from a counter reset, so we clamp to 0 (under-count rather than
// emit negative deltas).
func TestSampler_CounterResetClampedToZero(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	sent := runTicks(s, []ConnSnapshot{
		{"landing-aabb1122": {Up: 5000, Down: 10000}},
		{"landing-aabb1122": {Up: 100, Down: 200}}, // both directions dropped
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch, got %d", len(sent))
	}
	s0 := sent[0].Samples[0]
	if s0.BytesUp != 0 {
		t.Errorf("BytesUp = %d after counter drop, want 0", s0.BytesUp)
	}
	if s0.BytesDown != 0 {
		t.Errorf("BytesDown = %d after counter drop, want 0", s0.BytesDown)
	}
}

// TestSampler_NewTagEmitted verifies that a tag appearing for the first time emits its current value as delta.
func TestSampler_NewTagEmitted(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	sent := runTicks(s, []ConnSnapshot{
		{"landing-aabb1122": {Up: 1000, Down: 2000}},
		{
			"landing-aabb1122": {Up: 1500, Down: 2500},
			"relay-ccdd3344":   {Up: 800, Down: 1600}, // new tag
		},
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch, got %d", len(sent))
	}
	// Find the relay sample
	var relaySample *agentapi.SingboxTrafficSample
	for i := range sent[0].Samples {
		if sent[0].Samples[i].Tag == "relay-ccdd3344" {
			relaySample = &sent[0].Samples[i]
			break
		}
	}
	if relaySample == nil {
		t.Fatal("relay-ccdd3344 sample not found in batch")
	}
	// New tag: prev is zero, so delta = current value
	if relaySample.BytesUp != 800 {
		t.Errorf("new tag BytesUp = %d, want 800", relaySample.BytesUp)
	}
	if relaySample.BytesDown != 1600 {
		t.Errorf("new tag BytesDown = %d, want 1600", relaySample.BytesDown)
	}
	if relaySample.Kind != "relay" {
		t.Errorf("new tag Kind = %q, want 'relay'", relaySample.Kind)
	}
}

// TestSampler_ClosedTagSkipped verifies that tags present in prev but absent in current are skipped.
// When a connection closes, its bytes are no longer in the snapshot; we can't recover them.
// This is a documented limitation: bytes transferred after the last poll are lost.
func TestSampler_ClosedTagSkipped(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	sent := runTicks(s, []ConnSnapshot{
		{
			"landing-aabb1122": {Up: 1000, Down: 2000},
			"relay-ccdd3344":   {Up: 500, Down: 1000},
		},
		{
			"landing-aabb1122": {Up: 1200, Down: 2400},
			// relay-ccdd3344 gone (connection closed)
		},
	})
	if len(sent) != 1 {
		t.Fatalf("expected 1 batch, got %d", len(sent))
	}
	// Only landing tag should appear; relay is closed
	if len(sent[0].Samples) != 1 {
		t.Errorf("expected 1 sample (closed tag skipped), got %d", len(sent[0].Samples))
	}
	if sent[0].Samples[0].Tag != "landing-aabb1122" {
		t.Errorf("sample tag = %q, want 'landing-aabb1122'", sent[0].Samples[0].Tag)
	}
}

// TestSampler_QueryErrorSkipsSend verifies that a fetch error suppresses send without panicking.
func TestSampler_QueryErrorSkipsSend(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	var sendCalled bool
	s.Send = func(_ agentapi.Envelope) error { sendCalled = true; return nil }
	s.fetchFunc = func(_, _ string) (ConnSnapshot, error) {
		return nil, fmt.Errorf("connection refused")
	}
	s.tick(context.Background())
	if sendCalled {
		t.Error("Send must not be called when fetch fails")
	}
}

// TestSampler_SendErrorLogsAndContinues verifies that Send returning an error does not
// stop the loop or panic; subsequent ticks still attempt to send.
func TestSampler_SendErrorLogsAndContinues(t *testing.T) {
	s := &Sampler{APIAddress: "127.0.0.1:29090", Interval: time.Millisecond}
	callCount := 0
	s.Send = func(_ agentapi.Envelope) error {
		callCount++
		return fmt.Errorf("network error")
	}
	// 3 ticks: tick1=baseline, tick2=error send, tick3=error send again
	snapshots := []ConnSnapshot{
		{"landing-aabb1122": {Up: 1000, Down: 2000}},
		{"landing-aabb1122": {Up: 1500, Down: 2500}},
		{"landing-aabb1122": {Up: 2000, Down: 3000}},
	}
	for _, snap := range snapshots {
		snap := snap
		s.fetchFunc = func(_, _ string) (ConnSnapshot, error) { return snap, nil }
		s.tick(context.Background())
	}
	// Ticks 2 and 3 should both attempt send (even though they fail)
	if callCount != 2 {
		t.Errorf("Send called %d times, want 2", callCount)
	}
}
