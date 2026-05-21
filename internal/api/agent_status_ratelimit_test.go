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
