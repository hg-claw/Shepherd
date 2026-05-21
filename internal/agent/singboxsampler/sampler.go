package singboxsampler

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// Sampler polls the sing-box clash-api GET /connections endpoint every Interval,
// aggregates per-inbound-tag byte counters into a ConnSnapshot, computes deltas
// vs the previous snapshot, and emits SingboxTrafficBatch envelopes via Send.
//
// Counter-reset / connection-close ambiguity:
// In sing-box the aggregated bytes for a tag can decrease between polls when
// high-traffic connections close — we cannot distinguish this from a genuine
// counter reset (e.g. sing-box restart). We clamp any negative delta to 0 to
// avoid emitting negative traffic (known limitation: bytes transferred after the
// last poll and before close are silently lost).
//
// Closed-tag handling:
// Tags that were present in prev but absent in current (connections closed) are
// skipped entirely. Their post-last-poll bytes are unrecoverable.
type Sampler struct {
	// APIAddress is the clash-api listen address. Defaults to 127.0.0.1:29090.
	APIAddress string
	// Secret is the optional clash-api bearer token. When non-empty it is sent
	// as "Authorization: Bearer <secret>".
	Secret string
	// Interval between polls. Defaults to 30s.
	Interval time.Duration
	// Send is called with each encoded SingboxTrafficBatch envelope. May be nil
	// (batches are dropped). Send errors are logged but do not stop the loop.
	Send func(agentapi.Envelope) error

	// fetchFunc is swapped in tests; production code uses httpFetch.
	fetchFunc func(addr, secret string) (ConnSnapshot, error)

	prev       ConnSnapshot
	prevExists bool
}

func (s *Sampler) effectiveAPIAddress() string {
	if s.APIAddress != "" {
		return s.APIAddress
	}
	return "127.0.0.1:29090"
}

func (s *Sampler) effectiveInterval() time.Duration {
	if s.Interval > 0 {
		return s.Interval
	}
	return 30 * time.Second
}

func (s *Sampler) fetch(ctx context.Context) (ConnSnapshot, error) {
	if s.fetchFunc != nil {
		return s.fetchFunc(s.effectiveAPIAddress(), s.Secret)
	}
	return httpFetch(ctx, s.effectiveAPIAddress(), s.Secret)
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

// tick is one sampling cycle. Exported-by-lowercase so tests can call it directly.
func (s *Sampler) tick(ctx context.Context) {
	cur, err := s.fetch(ctx)
	if err != nil {
		log.Printf("singboxsampler: fetch failed: %v", err)
		return
	}

	// First tick: store snapshot as baseline, do not emit.
	if !s.prevExists {
		s.prev = cur
		s.prevExists = true
		return
	}

	now := time.Now().UTC()
	samples := make([]agentapi.SingboxTrafficSample, 0, len(cur))

	for tag, tb := range cur {
		prev := s.prev[tag] // zero value if tag is new

		up := tb.Up - prev.Up
		if up < 0 {
			// Counter decrease: connections closed or sing-box restart.
			// Clamp to 0 — we'd rather under-count than emit negative bytes.
			up = 0
		}

		down := tb.Down - prev.Down
		if down < 0 {
			down = 0
		}

		// Derive kind from tag prefix (e.g. "landing-aabb1122" → "landing",
		// "relay-ccdd3344" → "relay"). Default to "landing" for unknown prefixes.
		kind := "landing"
		if strings.HasPrefix(tag, "relay-") {
			kind = "relay"
		}

		samples = append(samples, agentapi.SingboxTrafficSample{
			Tag:       tag,
			Kind:      kind,
			TS:        now,
			BytesUp:   up,
			BytesDown: down,
		})
	}
	// Tags present in prev but absent in cur are skipped (connections closed;
	// their bytes between the last poll and close are unrecoverable).

	env, err := agentapi.Frame(agentapi.TypeSingboxTraffic, agentapi.SingboxTrafficBatch{Samples: samples})
	if err != nil {
		log.Printf("singboxsampler: frame error: %v", err)
		// Still update prev so the next tick doesn't double-count.
		s.prev = cur
		return
	}

	if s.Send != nil {
		if err := s.Send(env); err != nil {
			log.Printf("singboxsampler: send failed (dropped): %v", err)
		}
	}

	s.prev = cur
}

// httpFetch issues GET /connections against the sing-box clash-api and returns
// a ConnSnapshot parsed by ParseConnections.
func httpFetch(ctx context.Context, addr, secret string) (ConnSnapshot, error) {
	url := fmt.Sprintf("http://%s/connections", addr)

	hctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(hctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("singboxsampler: build request: %w", err)
	}
	if secret != "" {
		req.Header.Set("Authorization", "Bearer "+secret)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("singboxsampler: GET /connections: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("singboxsampler: read body: %w", err)
	}

	return ParseConnections(data)
}
