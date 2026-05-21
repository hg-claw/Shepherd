package xraysampler

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// statKey identifies a single directional counter.
// Dir is "up" (uplink) or "down" (downlink).
type statKey struct {
	Kind string
	Tag  string
	Dir  string
}

// Sampler collects xray traffic stats every Interval and emits XrayTrafficBatch envelopes.
type Sampler struct {
	// APIAddress is the TCP address of xray's stats API inbound (host:port).
	// Defaults to 127.0.0.1:28085 — matches the renderer's injected api inbound.
	APIAddress string
	// Interval is the sampling interval. Defaults to 30s.
	Interval time.Duration
	// Send is called with each batch envelope. May be nil (batches are dropped).
	Send func(agentapi.Envelope) error

	// queryFunc is injected in tests; production uses queryStatsViaCLI.
	queryFunc func(address string) (map[statKey]int64, error)

	prev       map[statKey]int64
	prevExists bool
}

func (s *Sampler) effectiveAPIAddress() string {
	if s.APIAddress != "" {
		return s.APIAddress
	}
	return "127.0.0.1:28085"
}

func (s *Sampler) effectiveInterval() time.Duration {
	if s.Interval > 0 {
		return s.Interval
	}
	return 30 * time.Second
}

func (s *Sampler) query(address string) (map[statKey]int64, error) {
	if s.queryFunc != nil {
		return s.queryFunc(address)
	}
	return queryStatsViaCLI(address)
}

// Run blocks until ctx is canceled, ticking every Interval.
func (s *Sampler) Run(ctx context.Context) {
	t := time.NewTicker(s.effectiveInterval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// pluginInstalledFn is the deploy-presence check. Overridden in tests so
// they don't depend on the binary actually being on disk at xrayBinaryPath.
var pluginInstalledFn = func() bool {
	_, err := os.Stat(xrayBinaryPath)
	return err == nil
}

// tick is one sampling cycle. It is exported-by-lowercase so tests can call it directly.
func (s *Sampler) tick(_ context.Context) {
	// Skip silently when xray isn't deployed on this host. The binary at
	// xrayBinaryPath is what shepherd's xray plugin pushes when a host
	// gets the plugin enabled — absence ≡ "this host has no xray".
	// Pre-fix, query() failed every interval with "no such file or
	// directory" and spammed agent logs.
	if !pluginInstalledFn() {
		return
	}
	cur, err := s.query(s.effectiveAPIAddress())
	if err != nil {
		log.Printf("xraysampler: query failed: %v", err)
		return
	}

	// First tick: store snapshot, do not emit.
	if !s.prevExists {
		s.prev = cur
		s.prevExists = true
		return
	}

	// Aggregate deltas by (kind, tag).
	type tagKind struct{ Kind, Tag string }
	type upDown struct{ Up, Down int64 }
	deltas := map[tagKind]upDown{}

	for k, curVal := range cur {
		prevVal := s.prev[k]
		delta := curVal - prevVal
		if delta < 0 {
			// xray restart: counter reset, treat as 0.
			delta = 0
		}
		tk := tagKind{Kind: k.Kind, Tag: k.Tag}
		d := deltas[tk]
		if k.Dir == "up" {
			d.Up += delta
		} else {
			d.Down += delta
		}
		deltas[tk] = d
	}

	now := time.Now().UTC()
	samples := make([]agentapi.XrayTrafficSample, 0, len(deltas))
	for tk, d := range deltas {
		samples = append(samples, agentapi.XrayTrafficSample{
			Tag:       tk.Tag,
			Kind:      tk.Kind,
			TS:        now,
			BytesUp:   d.Up,
			BytesDown: d.Down,
		})
	}

	env, err := agentapi.Frame(agentapi.TypeXrayTraffic, agentapi.XrayTrafficBatch{Samples: samples})
	if err != nil {
		log.Printf("xraysampler: frame error: %v", err)
		s.prev = cur
		return
	}

	if s.Send != nil {
		if err := s.Send(env); err != nil {
			log.Printf("xraysampler: send failed (dropped): %v", err)
		}
	}

	s.prev = cur
}

// xrayBinaryPath is the canonical install path used by the xray plugin's
// Pusher.DeployService (see internal/plugins/xray/xray.go). Using the full
// path avoids depending on PATH and matches the file the plugin pushes.
const xrayBinaryPath = "/usr/local/bin/shepherd-xray"

// queryStatsViaCLI runs `shepherd-xray api statsquery` against the xray
// stats TCP inbound and returns a map of directional counters keyed by
// statKey.
func queryStatsViaCLI(address string) (map[statKey]int64, error) {
	cmd := exec.Command(xrayBinaryPath, "api", "statsquery",
		fmt.Sprintf("--server=%s", address),
		"--reset=false",
	)
	out, err := cmd.Output()
	if err != nil {
		// .Output() puts stderr on ExitError.Stderr; surface it so the
		// caller's log shows what xray actually complained about instead
		// of just "exit status N".
		if ee, ok := err.(*exec.ExitError); ok && len(ee.Stderr) > 0 {
			return nil, fmt.Errorf("xray api statsquery: %w: %s",
				err, strings.TrimSpace(string(ee.Stderr)))
		}
		return nil, fmt.Errorf("xray api statsquery: %w", err)
	}
	entries, err := ParseStats(out)
	if err != nil {
		return nil, err
	}
	m := make(map[statKey]int64, len(entries))
	for _, e := range entries {
		dir := "down"
		if e.Direction == "uplink" {
			dir = "up"
		}
		m[statKey{Kind: e.Kind, Tag: e.Tag, Dir: dir}] = e.Value
	}
	return m, nil
}
