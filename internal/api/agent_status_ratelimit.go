package api

import (
	"sync"
	"time"
)

// tokenRateLimiter is a per-key sliding-window counter. Each key independently
// gets `max` hits per `window`. Hits older than `window` are discarded on every
// allow() call. Safe for concurrent use.
//
// Keyspace is small (one entry per active enrollment token) so the map of
// slices does not need a bounded size.
type tokenRateLimiter struct {
	max    int
	window time.Duration
	mu     sync.Mutex
	hits   map[string][]time.Time
	now    func() time.Time
}

func newTokenRateLimiter(max int, window time.Duration) *tokenRateLimiter {
	return &tokenRateLimiter{
		max:    max,
		window: window,
		hits:   map[string][]time.Time{},
		now:    time.Now,
	}
}

func (l *tokenRateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	cutoff := now.Add(-l.window)
	// Drop expired entries.
	prev := l.hits[key]
	kept := prev[:0]
	for _, t := range prev {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.max {
		l.hits[key] = kept
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}
