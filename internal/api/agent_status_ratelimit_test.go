package api

import (
	"testing"
	"time"
)

func TestTokenRateLimiter_AllowsUnderLimit(t *testing.T) {
	lim := newTokenRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		if !lim.allow("abc") {
			t.Fatalf("hit %d: unexpected reject", i)
		}
	}
}

func TestTokenRateLimiter_RejectsOverLimit(t *testing.T) {
	lim := newTokenRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		lim.allow("abc")
	}
	if lim.allow("abc") {
		t.Fatalf("4th hit should be rejected")
	}
}

func TestTokenRateLimiter_PerTokenIsolation(t *testing.T) {
	lim := newTokenRateLimiter(3, time.Minute)
	for i := 0; i < 3; i++ {
		lim.allow("abc")
	}
	if !lim.allow("xyz") {
		t.Fatalf("different token should not be rate-limited")
	}
}

func TestTokenRateLimiter_WindowAdvances(t *testing.T) {
	lim := newTokenRateLimiter(3, 50*time.Millisecond)
	for i := 0; i < 3; i++ {
		lim.allow("abc")
	}
	if lim.allow("abc") {
		t.Fatalf("should be rejected before window advance")
	}
	time.Sleep(60 * time.Millisecond)
	if !lim.allow("abc") {
		t.Fatalf("should be allowed after window advance")
	}
}

func TestTokenRateLimiter_BlockedDoesNotIncrement(t *testing.T) {
	lim := newTokenRateLimiter(2, time.Minute)
	for i := 0; i < 5; i++ {
		if lim.blocked("k") {
			t.Fatalf("blocked at peek %d before any record", i)
		}
	}
	lim.record("k")
	lim.record("k")
	if !lim.blocked("k") {
		t.Fatalf("should be blocked after 2 records")
	}
}

func TestTokenRateLimiter_ResetClears(t *testing.T) {
	lim := newTokenRateLimiter(1, time.Minute)
	lim.record("k")
	if !lim.blocked("k") {
		t.Fatalf("should be blocked")
	}
	lim.reset("k")
	if lim.blocked("k") {
		t.Fatalf("reset should clear the key")
	}
}

func TestTokenRateLimiter_SweepEvictsExpiredKeys(t *testing.T) {
	clock := time.Unix(1000, 0)
	lim := newTokenRateLimiter(5, time.Minute)
	lim.now = func() time.Time { return clock }
	lim.record("a")
	lim.record("b")
	clock = clock.Add(3 * time.Minute)
	lim.blocked("c") // any op triggers maybeSweep
	if len(lim.hits) != 0 {
		t.Fatalf("expired keys not swept: %v", lim.hits)
	}
}

func TestTokenRateLimiter_MaxKeysCap(t *testing.T) {
	lim := newTokenRateLimiter(5, time.Minute)
	lim.maxKeys = 2
	lim.record("a")
	lim.record("b")
	lim.record("c") // map full → new key dropped (fail-closed)
	if _, ok := lim.hits["c"]; ok {
		t.Fatalf("new key recorded past maxKeys cap")
	}
	if lim.allow("d") {
		t.Fatalf("allow must fail-closed for a new key when at cap")
	}
}
