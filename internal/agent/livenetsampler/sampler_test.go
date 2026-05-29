package livenetsampler

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func TestTick_SendsWhenOK(t *testing.T) {
	var sent []agentapi.Envelope
	s := &Sampler{
		Send:   func(e agentapi.Envelope) error { sent = append(sent, e); return nil },
		Source: func() (int64, int64, bool) { return 100, 200, true },
	}
	s.tick()
	if len(sent) != 1 || sent[0].Type != agentapi.TypeLiveNet {
		t.Fatalf("expected one live.net frame, got %+v", sent)
	}
	var p agentapi.LiveNetSample
	if err := sent[0].Decode(&p); err != nil || p.RxBps != 100 || p.TxBps != 200 {
		t.Fatalf("payload: %+v err=%v", p, err)
	}
}

func TestTick_SkipsWhenNotOK(t *testing.T) {
	called := false
	s := &Sampler{
		Send:   func(e agentapi.Envelope) error { called = true; return nil },
		Source: func() (int64, int64, bool) { return 0, 0, false },
	}
	s.tick()
	if called {
		t.Fatal("should not send when source not ok")
	}
}

func TestRun_StopsOnCancel(t *testing.T) {
	s := &Sampler{
		Interval: 5 * time.Millisecond,
		Send:     func(e agentapi.Envelope) error { return nil },
		Source:   func() (int64, int64, bool) { return 1, 1, true },
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not return after cancel")
	}
}
