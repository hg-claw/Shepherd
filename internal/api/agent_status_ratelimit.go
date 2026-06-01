package api

import (
	"sync"
	"time"
)

// tokenRateLimiter is a bounded per-key sliding-window counter. Each key gets
// `max` hits per `window`. Expired keys are evicted by an opportunistic sweep
// (time-based or when the map exceeds maxKeys); under a flood of unique keys the
// map is capped at maxKeys and brand-new keys fail closed. Safe for concurrent use.
//
// blocked/record/reset let callers peek without counting (login: peek before
// auth, record only on failure, reset on success); allow() keeps the original
// check-then-increment semantics for the token endpoints.
type tokenRateLimiter struct {
	max       int
	window    time.Duration
	maxKeys   int
	mu        sync.Mutex
	hits      map[string][]time.Time
	lastSweep time.Time
	now       func() time.Time
}

func newTokenRateLimiter(max int, window time.Duration) *tokenRateLimiter {
	return &tokenRateLimiter{
		max:     max,
		window:  window,
		maxKeys: 50_000,
		hits:    map[string][]time.Time{},
		now:     time.Now,
	}
}

// pruneLocked returns key's live (within-window) hits, writing the pruned slice
// back (deleting the key if empty). Caller holds mu.
func (l *tokenRateLimiter) pruneLocked(key string, now time.Time) []time.Time {
	cutoff := now.Add(-l.window)
	prev := l.hits[key]
	kept := prev[:0]
	for _, t := range prev {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.hits, key)
	} else {
		l.hits[key] = kept
	}
	return kept
}

// sweepLocked drops every key whose hits are all expired. Caller holds mu.
func (l *tokenRateLimiter) sweepLocked(now time.Time) {
	cutoff := now.Add(-l.window)
	for k, hs := range l.hits {
		alive := false
		for _, t := range hs {
			if t.After(cutoff) {
				alive = true
				break
			}
		}
		if !alive {
			delete(l.hits, k)
		}
	}
	l.lastSweep = now
}

// maybeSweepLocked sweeps on a timer or when the map is over its cap. Caller holds mu.
func (l *tokenRateLimiter) maybeSweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) >= l.window || len(l.hits) >= l.maxKeys {
		l.sweepLocked(now)
	}
}

// addLocked prunes, enforces the cap, and appends a hit. Returns false if the cap
// rejected a brand-new key. Caller holds mu.
func (l *tokenRateLimiter) addLocked(key string, now time.Time) bool {
	kept := l.pruneLocked(key, now)
	if _, exists := l.hits[key]; !exists && len(l.hits) >= l.maxKeys {
		return false
	}
	l.hits[key] = append(kept, now)
	return true
}

// blocked reports whether key is at/over its limit, without recording a hit.
func (l *tokenRateLimiter) blocked(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybeSweepLocked(now)
	return len(l.pruneLocked(key, now)) >= l.max
}

// record adds a hit for key (the counting step).
func (l *tokenRateLimiter) record(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybeSweepLocked(now)
	l.addLocked(key, now)
}

// reset clears key's counter (e.g. after a successful login).
func (l *tokenRateLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.hits, key)
}

// allow is the original check-then-increment: false if at the limit (or capped).
func (l *tokenRateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	l.maybeSweepLocked(now)
	if len(l.pruneLocked(key, now)) >= l.max {
		return false
	}
	return l.addLocked(key, now)
}
