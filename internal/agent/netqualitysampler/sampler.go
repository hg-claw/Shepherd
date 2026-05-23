package netqualitysampler

import (
	"context"
	"fmt"
	"log"
	"os/exec"
	"sync"
	"time"

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

// defaultPingTimeout is the per-packet timeout passed to ping -W (Linux)
// or -t (BSD). 2s is high enough for trans-Pacific RTT (~250ms in
// practice) while still bounding the worst-case burst time to 20s.
const defaultPingTimeout = 2 * time.Second

// Sampler runs the per-target ping loop. The server pushes a config via
// SetConfig — until then Run is a no-op (no targets → no work).
//
// Concurrency: SetConfig is called from the wsclient reader goroutine;
// Run + tick are called from the sampler goroutine. The mu protects cfg
// against the obvious race.
type Sampler struct {
	// Send is called with each encoded NetqualityBatch envelope. May be
	// nil during construction; the loop short-circuits in that case.
	Send func(agentapi.Envelope) error

	// pingExec is swapped in tests with a fake that returns canned output.
	pingExec func(ctx context.Context, host string, count int, timeout time.Duration) (string, error)

	mu  sync.Mutex
	cfg agentapi.NetqualityConfig
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
		// Re-read the interval AFTER tick — operator changes apply at
		// the boundary, not mid-burst.
		timer.Reset(s.effectiveInterval(s.snapshot()))
	}
}

// tick runs one round: ping each target sequentially, build samples,
// emit one batch. Sequential rather than parallel because (a) the burst
// itself is bounded by the timeout and (b) parallel ping fans out ICMP
// floods that some IDS / hosting providers flag.
func (s *Sampler) tick(ctx context.Context, cfg agentapi.NetqualityConfig) {
	now := time.Now().UTC()
	samples := make([]agentapi.NetqualitySample, 0, len(cfg.Targets))
	for _, t := range cfg.Targets {
		samples = append(samples, s.probe(ctx, t, now))
	}
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

// probe runs ping(1) against one target and converts the result into a
// NetqualitySample. NEVER returns an error — even a complete ping
// failure is recorded as status="error" so the dashboards distinguish
// "haven't sampled yet" (no row) from "sampled and failed" (status row).
func (s *Sampler) probe(ctx context.Context, t agentapi.NetqualityTarget, ts time.Time) agentapi.NetqualitySample {
	sample := agentapi.NetqualitySample{TargetID: t.ID, TS: ts, Status: "error", LossPct: 100}
	out, _ := s.exec()(ctx, t.Host, defaultPingCount, defaultPingTimeout)
	// We ignore exec error: ping returns non-zero on partial loss too,
	// and the output still has the summary line we want. The only case
	// where we truly have nothing to parse is when ping never printed a
	// summary, which parsePingOutput surfaces via errNoLossLine.
	ps, err := parsePingOutput(out)
	if err != nil {
		return sample
	}
	sample.Status = ps.Status
	sample.LossPct = ps.LossPct
	sample.RTTAvgMs = ps.RTTAvgMs
	sample.RTTMinMs = ps.RTTMinMs
	sample.RTTMaxMs = ps.RTTMaxMs
	sample.JitterMs = ps.JitterMs
	return sample
}

func (s *Sampler) exec() func(context.Context, string, int, time.Duration) (string, error) {
	if s.pingExec != nil {
		return s.pingExec
	}
	return runPing
}

// runPing executes `ping -c <count> -W <timeout-seconds> <host>` and
// returns the combined stdout/stderr blob. Linux only for now; the BSD
// flag set (-W milliseconds vs seconds) differs and macOS hosts aren't
// in the agent's deployment matrix.
func runPing(ctx context.Context, host string, count int, timeout time.Duration) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, time.Duration(count+2)*timeout)
	defer cancel()
	args := []string{
		"-c", fmt.Sprintf("%d", count),
		"-W", fmt.Sprintf("%d", int(timeout.Seconds())),
		host,
	}
	out, err := exec.CommandContext(cctx, "ping", args...).CombinedOutput()
	return string(out), err
}
