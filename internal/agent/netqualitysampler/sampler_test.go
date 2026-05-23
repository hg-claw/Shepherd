package netqualitysampler

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func mkOKStats() *probeStats {
	return &probeStats{
		PacketsSent: 10, PacketsRecv: 10,
		AvgRtt: 2 * time.Millisecond,
		MinRtt: 1 * time.Millisecond,
		MaxRtt: 3 * time.Millisecond,
		StdDevRtt: 500 * time.Microsecond,
	}
}

func mkLostStats() *probeStats {
	return &probeStats{PacketsSent: 10, PacketsRecv: 0}
}

func TestProbe_OK(t *testing.T) {
	s := &Sampler{
		pingExec: func(_ context.Context, host string, _ int, _ time.Duration) (*probeStats, error) {
			if host != "1.1.1.1" {
				t.Errorf("probed wrong host: %q", host)
			}
			return mkOKStats(), nil
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 42, Host: "1.1.1.1"}, time.Now())
	if sample.Status != "ok" || sample.TargetID != 42 || sample.LossPct != 0 {
		t.Errorf("got %+v", sample)
	}
	if sample.RTTAvgMs == nil || *sample.RTTAvgMs != 2.0 {
		t.Errorf("rtt avg=%v want 2.0", sample.RTTAvgMs)
	}
	if sample.JitterMs == nil || *sample.JitterMs != 0.5 {
		t.Errorf("jitter=%v want 0.5", sample.JitterMs)
	}
}

func TestProbe_PartialLoss(t *testing.T) {
	s := &Sampler{
		pingExec: func(context.Context, string, int, time.Duration) (*probeStats, error) {
			return &probeStats{
				PacketsSent: 10, PacketsRecv: 7,
				AvgRtt: 12 * time.Millisecond,
				StdDevRtt: 1 * time.Millisecond,
			}, nil
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 1, Host: "8.8.8.8"}, time.Now())
	if sample.Status != "ok" {
		t.Errorf("partial loss status=%q want ok", sample.Status)
	}
	if sample.LossPct != 30 {
		t.Errorf("loss=%v want 30", sample.LossPct)
	}
}

func TestProbe_TotalLoss(t *testing.T) {
	s := &Sampler{
		pingExec: func(context.Context, string, int, time.Duration) (*probeStats, error) {
			return mkLostStats(), nil
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 1, Host: "192.0.2.1"}, time.Now())
	if sample.Status != "lost" {
		t.Errorf("status=%q want lost", sample.Status)
	}
	if sample.LossPct != 100 {
		t.Errorf("loss=%v want 100", sample.LossPct)
	}
	if sample.RTTAvgMs != nil {
		t.Errorf("expected nil rtt on total loss, got %v", *sample.RTTAvgMs)
	}
}

func TestProbe_ExecErrorRecordsError(t *testing.T) {
	// EPERM is the canonical "no CAP_NET_RAW" error we see in production.
	// The sampler must record status="error" (distinct from "lost") so
	// dashboards distinguish "OS refused" from "100% packet loss".
	s := &Sampler{
		pingExec: func(context.Context, string, int, time.Duration) (*probeStats, error) {
			return nil, errors.New("listen ip4:icmp 0.0.0.0: operation not permitted")
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 7, Host: "10.0.0.1"}, time.Now())
	if sample.Status != "error" {
		t.Errorf("status=%q want error", sample.Status)
	}
}

func TestProbe_ZeroPacketsSentRecordsError(t *testing.T) {
	// Kernel accepted the socket but didn't send anything — distinct
	// failure mode worth logging separately. Status is still 'error'.
	s := &Sampler{
		pingExec: func(context.Context, string, int, time.Duration) (*probeStats, error) {
			return &probeStats{PacketsSent: 0, PacketsRecv: 0}, nil
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 7, Host: "10.0.0.1"}, time.Now())
	if sample.Status != "error" {
		t.Errorf("status=%q want error", sample.Status)
	}
}

func TestTick_EmitsBatchWithEverySample(t *testing.T) {
	s := &Sampler{
		pingExec: func(context.Context, string, int, time.Duration) (*probeStats, error) {
			return mkOKStats(), nil
		},
	}
	var got agentapi.NetqualityBatch
	s.Send = func(env agentapi.Envelope) error {
		return env.Decode(&got)
	}
	cfg := agentapi.NetqualityConfig{
		Targets: []agentapi.NetqualityTarget{
			{ID: 1, Host: "1.1.1.1"},
			{ID: 2, Host: "8.8.8.8"},
		},
	}
	s.tick(context.Background(), cfg)
	if len(got.Samples) != 2 {
		t.Fatalf("samples=%d want 2", len(got.Samples))
	}
	seen := map[int64]bool{}
	for _, sm := range got.Samples {
		seen[sm.TargetID] = true
	}
	if !seen[1] || !seen[2] {
		t.Errorf("missing target IDs in batch: %+v", got.Samples)
	}
}

func TestRun_SkipsTickWhenNoTargets(t *testing.T) {
	var probes, sends int64
	s := &Sampler{
		pingExec: func(context.Context, string, int, time.Duration) (*probeStats, error) {
			atomic.AddInt64(&probes, 1)
			return mkOKStats(), nil
		},
		Send: func(agentapi.Envelope) error { atomic.AddInt64(&sends, 1); return nil },
	}
	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	<-done
	if atomic.LoadInt64(&probes) != 0 {
		t.Errorf("probed despite empty targets: %d", probes)
	}
	if atomic.LoadInt64(&sends) != 0 {
		t.Errorf("sent despite empty targets: %d", sends)
	}
}

func TestSetConfig_RaceFree(t *testing.T) {
	// SetConfig is called from the WS reader goroutine; the sampler
	// reads cfg on each tick. -race catches naive map/slice sharing.
	s := &Sampler{}
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			s.SetConfig(agentapi.NetqualityConfig{
				Targets: []agentapi.NetqualityTarget{{ID: int64(i), Host: "x"}},
			})
		}
		close(done)
	}()
	for i := 0; i < 1000; i++ {
		_ = s.snapshot()
	}
	<-done
}

func TestDurationMs_SubMillisecondPrecision(t *testing.T) {
	// We bucket the wire field as milliseconds but keep two decimals so
	// LAN RTTs (often 100-500μs) don't truncate to 0. Lock in the
	// μ→ms math so a future "let's just int-cast" simplification doesn't
	// silently degrade the dashboard.
	cases := []struct {
		in   time.Duration
		want float64
	}{
		{500 * time.Microsecond, 0.5},
		{1500 * time.Microsecond, 1.5},
		{0, 0},
	}
	for _, c := range cases {
		if got := durationMs(c.in); got != c.want {
			t.Errorf("durationMs(%v) = %v, want %v", c.in, got, c.want)
		}
	}
}
