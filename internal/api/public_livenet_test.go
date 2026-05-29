package api

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type captureConn struct{ got []any }

func (c *captureConn) WriteJSON(v any) error { c.got = append(c.got, v); return nil }

func TestPublicLiveNetSlotCap(t *testing.T) {
	a := &PublicAPI{}
	// acquire up to the cap
	for i := 0; i < maxPublicLiveNetConns; i++ {
		if !a.tryAcquireLiveNetSlot() {
			t.Fatalf("acquire %d should succeed", i)
		}
	}
	// next one is rejected
	if a.tryAcquireLiveNetSlot() {
		t.Fatal("acquire past cap should fail")
	}
	// release one, then acquire succeeds again
	a.releaseLiveNetSlot()
	if !a.tryAcquireLiveNetSlot() {
		t.Fatal("acquire after release should succeed")
	}
}

func TestTaggingConn_WrapsWithServerID(t *testing.T) {
	inner := &captureConn{}
	tc := &taggingConn{serverID: 42, inner: inner}
	if err := tc.WriteJSON(agentapi.LiveNetSample{RxBps: 10, TxBps: 20}); err != nil {
		t.Fatal(err)
	}
	if len(inner.got) != 1 {
		t.Fatalf("expected one wrapped frame, got %d", len(inner.got))
	}
	f, ok := inner.got[0].(wallLiveFrame)
	if !ok {
		t.Fatalf("expected wallLiveFrame, got %T", inner.got[0])
	}
	if f.ServerID != 42 || f.RxBps != 10 || f.TxBps != 20 {
		t.Fatalf("bad frame: %+v", f)
	}
}
