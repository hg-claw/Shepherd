// Package livenetsampler emits ~1s rate-only network throughput frames
// (TypeLiveNet) for the live server-detail view. It is intentionally
// independent of the 30s telemetry collector and carries NO byte deltas, so it
// never feeds cumulative-traffic accumulation.
package livenetsampler

import (
	"context"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// Sampler pushes a LiveNetSample every Interval while Run's context is live.
type Sampler struct {
	// Send is the agent's envelope sender (client.Send). Nil = no-op.
	Send func(agentapi.Envelope) error
	// Source returns the current rx/tx bps and ok=false to skip a tick
	// (first call primes the underlying meter). Injected for testability.
	Source func() (rxBps, txBps int64, ok bool)
	// Interval defaults to 1s.
	Interval time.Duration
}

func (s *Sampler) tick() {
	if s.Send == nil || s.Source == nil {
		return
	}
	rx, tx, ok := s.Source()
	if !ok {
		return
	}
	env, err := agentapi.Frame(agentapi.TypeLiveNet, agentapi.LiveNetSample{
		TS: time.Now().UTC(), RxBps: rx, TxBps: tx,
	})
	if err != nil {
		return
	}
	_ = s.Send(env)
}

// Run blocks until ctx is canceled, ticking every Interval (default 1s).
func (s *Sampler) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		interval = time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick()
		}
	}
}
