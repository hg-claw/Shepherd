// Package netqualitysampler runs periodic ICMP probes against a
// server-pushed target list and emits NetqualityBatch envelopes back to
// the server. It's the agent-side half of the netquality plugin; the
// catalog + ingest + rollup live server-side under
// internal/plugins/netquality and internal/telemetrysvc.
//
// Probe implementation: github.com/prometheus-community/pro-bing's
// native Go ICMP — NOT a shell-out to ping(1). The shell-out path was
// tried first (PR #54..#59) and failed for two unrelated reasons in
// production:
//   - Some hosts have ping(1) localised (LC_ALL=C wasn't enough on the
//     reporter's box — busybox builds ignore LANG/LC env vars).
//   - The output parser was English-only, so a slightly different ping
//     binary (iputils vs busybox vs s6's variant) silently produced
//     status="error" rows that gave operators nothing to investigate.
//
// Going native sidesteps both: pro-bing constructs and decodes ICMP
// packets itself, returns a typed *Statistics, and surfaces a real
// Go error when the OS refuses (most often EPERM with no CAP_NET_RAW
// and an unset ping_group_range — diagnostics for that case land in
// the probe log line below).
package netqualitysampler

import (
	"context"
	"log"
	"sync"
	"time"

	probing "github.com/prometheus-community/pro-bing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// defaultIntervalSeconds matches the netquality_hosts.sample_interval_seconds
// default in the schema. Used when the server pushes 0 (which we treat as
// "use the default", not "sample as fast as possible").
const defaultIntervalSeconds = 300

// defaultPingCount is the burst size per target. 10 gives a meaningful
// jitter value while staying well under the typical 60-second human
// patience threshold (each burst takes ~loss×n×1s in the worst case).
const defaultPingCount = 10

// defaultPingTimeout is the per-burst timeout. We let pro-bing drive
// pacing itself; this is the total wall clock budget after which we
// take whatever stats we have.
const defaultPingTimeout = 12 * time.Second

// Sampler runs the per-target ICMP loop. The server pushes a config via
// SetConfig — until then Run is a no-op (no targets → no work).
//
// Concurrency: SetConfig is called from the wsclient reader goroutine;
// Run + tick are called from the sampler goroutine. The mu protects cfg
// against the obvious race.
type Sampler struct {
	// Send is called with each encoded NetqualityBatch envelope. May be
	// nil during construction; the loop short-circuits in that case.
	Send func(agentapi.Envelope) error

	// pingExec is swapped in tests with a fake that returns canned stats.
	// Production code uses doPing below.
	pingExec func(ctx context.Context, host string, count int, timeout time.Duration) (*probeStats, error)

	mu  sync.Mutex
	cfg agentapi.NetqualityConfig
}

// probeStats is the structured result of one ping burst. Mirrors the
// subset of pro-bing's *Statistics we forward to the server.
type probeStats struct {
	PacketsSent int
	PacketsRecv int
	AvgRtt      time.Duration
	MinRtt      time.Duration
	MaxRtt      time.Duration
	StdDevRtt   time.Duration // pro-bing's "stddev" — what we surface as jitter
}

// SetConfig replaces the current ping plan. Called by the WS receiver
// each time the server pushes TypeNetqualityConfig. An empty Targets
// list disables sampling; we keep the interval value for the next push.
func (s *Sampler) SetConfig(cfg agentapi.NetqualityConfig) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cfg = cfg
}

func (s *Sampler) snapshot() agentapi.NetqualityConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cfg
}

func (s *Sampler) effectiveInterval(cfg agentapi.NetqualityConfig) time.Duration {
	if cfg.IntervalSeconds <= 0 {
		return time.Duration(defaultIntervalSeconds) * time.Second
	}
	return time.Duration(cfg.IntervalSeconds) * time.Second
}

// Run blocks until ctx is canceled. Re-reads the cached config on every
// tick so a mid-flight SetConfig (e.g. operator bumps the interval) takes
// effect at the next probe round rather than at the next reconnect.
func (s *Sampler) Run(ctx context.Context) {
	// First tick: short delay to let the WS reader land the initial
	// config push before we'd otherwise fire an empty-targets no-op.
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		cfg := s.snapshot()
		if len(cfg.Targets) > 0 {
			s.tick(ctx, cfg)
		}
		timer.Reset(s.effectiveInterval(s.snapshot()))
	}
}

// tick runs one round: ping every target in parallel (bounded fan-out),
// build samples, emit one batch.
//
// Pre-fix this was sequential: 19 targets × up to 12s per timed-out
// burst = 228s worst case, so a 60s sample_interval couldn't keep up
// and the operator saw "1 min set, points every ~3 min" in production.
// Parallelising bounds the round to roughly the slowest single target
// regardless of count. Each pinger uses its own ICMP socket so they
// don't contend on a shared resource; the "ICMP flood" concern that
// motivated the old sequential design only applies to mass packets at
// ONE destination, which is the opposite of what we're doing.
//
// Concurrency cap is 16 so a host configured with 100+ custom targets
// still won't open hundreds of raw sockets at once.
func (s *Sampler) tick(ctx context.Context, cfg agentapi.NetqualityConfig) {
	now := time.Now().UTC()
	samples := make([]agentapi.NetqualitySample, len(cfg.Targets))

	const maxParallel = 16
	sem := make(chan struct{}, maxParallel)
	var wg sync.WaitGroup
	for i, tgt := range cfg.Targets {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, t agentapi.NetqualityTarget) {
			defer wg.Done()
			defer func() { <-sem }()
			samples[idx] = s.probe(ctx, t, now)
		}(i, tgt)
	}
	wg.Wait()

	env, err := agentapi.Frame(agentapi.TypeNetqualityBatch, agentapi.NetqualityBatch{Samples: samples})
	if err != nil {
		log.Printf("netqualitysampler: frame error: %v", err)
		return
	}
	if s.Send == nil {
		return
	}
	if err := s.Send(env); err != nil {
		log.Printf("netqualitysampler: send failed (dropped): %v", err)
	}
}

// probe runs one ICMP burst against one target. NEVER returns an error —
// even a complete failure is recorded as status="error" so the
// dashboards distinguish "haven't sampled yet" (no row) from "sampled
// and failed" (status row).
func (s *Sampler) probe(ctx context.Context, t agentapi.NetqualityTarget, ts time.Time) agentapi.NetqualitySample {
	sample := agentapi.NetqualitySample{TargetID: t.ID, TS: ts, Status: "error", LossPct: 100}
	st, err := s.exec()(ctx, t.Host, defaultPingCount, defaultPingTimeout)
	if err != nil {
		// Log every probe failure once — operators see the real OS
		// error (usually "operation not permitted" when CAP_NET_RAW
		// isn't set + ping_group_range is empty, or "no route to host"
		// for misconfigured firewalls). Pre-fix this turned into a
		// silent status='error' row with no clue why.
		log.Printf("netqualitysampler: probe %q: %v", t.Host, err)
		return sample
	}
	if st.PacketsSent == 0 {
		// Couldn't send a single packet — treat as error rather than
		// 100% loss so the operator knows it's a process-level issue
		// (e.g. routing table empty), not a network reachability one.
		log.Printf("netqualitysampler: probe %q: 0 packets sent (config rejected by kernel)", t.Host)
		return sample
	}
	loss := 100 * float64(st.PacketsSent-st.PacketsRecv) / float64(st.PacketsSent)
	sample.LossPct = loss
	if st.PacketsRecv == 0 {
		sample.Status = "lost"
		return sample
	}
	sample.Status = "ok"
	avg := durationMs(st.AvgRtt)
	mn := durationMs(st.MinRtt)
	mx := durationMs(st.MaxRtt)
	jit := durationMs(st.StdDevRtt)
	sample.RTTAvgMs = &avg
	sample.RTTMinMs = &mn
	sample.RTTMaxMs = &mx
	sample.JitterMs = &jit
	return sample
}

func (s *Sampler) exec() func(context.Context, string, int, time.Duration) (*probeStats, error) {
	if s.pingExec != nil {
		return s.pingExec
	}
	return doPing
}

// doPing runs the actual ICMP burst via pro-bing. Privileged mode uses
// SOCK_RAW (needs CAP_NET_RAW); the agent runs as root under its
// systemd unit so this is the natural fit. On hosts that drop the
// capability the operator's signal is the EPERM in probe's log line.
func doPing(ctx context.Context, host string, count int, timeout time.Duration) (*probeStats, error) {
	p, err := probing.NewPinger(host)
	if err != nil {
		return nil, err
	}
	p.Count = count
	p.Timeout = timeout
	// Interval between sends. The default (1s) makes a 10-packet burst
	// take 10s wall clock — too long when 30 targets × N hosts.
	p.Interval = 200 * time.Millisecond
	// SOCK_RAW on Linux. On macOS / when running as root inside an
	// unprivileged container this still works because Docker grants
	// CAP_NET_RAW by default.
	p.SetPrivileged(true)

	// pro-bing's Run() blocks until Count is hit OR Timeout elapses.
	// Wrap in our own ctx so a Run() cancel takes the pinger down
	// promptly — without this the goroutine could outlive the tick.
	done := make(chan error, 1)
	go func() { done <- p.RunWithContext(ctx) }()
	select {
	case <-ctx.Done():
		p.Stop()
		<-done
		return nil, ctx.Err()
	case err := <-done:
		if err != nil {
			return nil, err
		}
	}

	st := p.Statistics()
	return &probeStats{
		PacketsSent: st.PacketsSent,
		PacketsRecv: st.PacketsRecv,
		AvgRtt:      st.AvgRtt,
		MinRtt:      st.MinRtt,
		MaxRtt:      st.MaxRtt,
		StdDevRtt:   st.StdDevRtt,
	}, nil
}

// durationMs returns the duration as milliseconds with sub-ms precision.
func durationMs(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000.0
}
