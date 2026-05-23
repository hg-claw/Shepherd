package netqualitysampler

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func mkOKOutput() string {
	return `--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 1.0/2.0/3.0/0.5 ms`
}

func mkLostOutput() string {
	return `--- 192.0.2.1 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2046ms`
}

func TestProbe_OK(t *testing.T) {
	s := &Sampler{
		pingExec: func(_ context.Context, host string, _ int, _ time.Duration) (string, error) {
			if host != "1.1.1.1" {
				t.Errorf("probed wrong host: %q", host)
			}
			return mkOKOutput(), nil
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 42, Host: "1.1.1.1"}, time.Now())
	if sample.Status != "ok" || sample.TargetID != 42 || sample.LossPct != 0 {
		t.Errorf("got %+v", sample)
	}
	if sample.RTTAvgMs == nil || *sample.RTTAvgMs != 2.0 {
		t.Errorf("rtt=%v", sample.RTTAvgMs)
	}
}

func TestProbe_Lost(t *testing.T) {
	s := &Sampler{
		pingExec: func(_ context.Context, _ string, _ int, _ time.Duration) (string, error) {
			return mkLostOutput(), errors.New("exit status 1") // ping returns non-zero on loss
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 1, Host: "192.0.2.1"}, time.Now())
	if sample.Status != "lost" || sample.LossPct != 100 {
		t.Errorf("got %+v", sample)
	}
	if sample.RTTAvgMs != nil {
		t.Errorf("expected nil rtt on total loss, got %v", *sample.RTTAvgMs)
	}
}

func TestProbe_PingExecFails_RecordsErrorStatus(t *testing.T) {
	// ping binary missing / no route: combined output empty, exit
	// error. parsePingOutput returns errNoLossLine; sampler should
	// record status="error" rather than dropping the sample.
	s := &Sampler{
		pingExec: func(_ context.Context, _ string, _ int, _ time.Duration) (string, error) {
			return "", errors.New("exec: no such file")
		},
	}
	sample := s.probe(context.Background(), agentapi.NetqualityTarget{ID: 7, Host: "10.0.0.1"}, time.Now())
	if sample.Status != "error" {
		t.Errorf("status=%q want error", sample.Status)
	}
	if sample.LossPct != 100 {
		t.Errorf("loss=%v want 100 on exec failure", sample.LossPct)
	}
}

func TestTick_EmitsBatchWithEverySample(t *testing.T) {
	s := &Sampler{
		pingExec: func(_ context.Context, _ string, _ int, _ time.Duration) (string, error) {
			return mkOKOutput(), nil
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
	// Empty target list = disabled host. Run should idle through ticks
	// without ever calling pingExec or Send. We catch both via atomics.
	var probes, sends int64
	s := &Sampler{
		pingExec: func(_ context.Context, _ string, _ int, _ time.Duration) (string, error) {
			atomic.AddInt64(&probes, 1)
			return mkOKOutput(), nil
		},
		Send: func(agentapi.Envelope) error { atomic.AddInt64(&sends, 1); return nil },
	}
	// No SetConfig — cfg is zero-value, Targets empty.

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
	// reads cfg on each tick. -race catches naive map/slice sharing;
	// this just exercises the path.
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
