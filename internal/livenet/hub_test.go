package livenet

import (
	"errors"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type fakeConn struct {
	got  []agentapi.LiveNetSample
	fail bool
}

func (c *fakeConn) WriteJSON(v any) error {
	if c.fail {
		return errors.New("boom")
	}
	c.got = append(c.got, v.(agentapi.LiveNetSample))
	return nil
}

func TestHub_PublishFansOutToWatchers(t *testing.T) {
	h := NewHub()
	c := &fakeConn{}
	detach := h.Attach(1, c)
	defer detach()
	h.Publish(1, agentapi.LiveNetSample{RxBps: 10, TxBps: 20})
	if len(c.got) != 1 || c.got[0].RxBps != 10 {
		t.Fatalf("watcher got %+v", c.got)
	}
	h.Publish(2, agentapi.LiveNetSample{RxBps: 99})
	if len(c.got) != 1 {
		t.Fatalf("cross-server leak: %+v", c.got)
	}
}

func TestHub_AttachBackfillsRing(t *testing.T) {
	h := NewHub()
	for i := 0; i < 65; i++ {
		h.Publish(1, agentapi.LiveNetSample{RxBps: int64(i)})
	}
	c := &fakeConn{}
	detach := h.Attach(1, c)
	defer detach()
	if len(c.got) != 60 || c.got[0].RxBps != 5 || c.got[59].RxBps != 64 {
		t.Fatalf("backfill got %d items, first=%+v last=%+v", len(c.got), c.got[0], c.got[len(c.got)-1])
	}
}

func TestHub_DetachStopsDelivery(t *testing.T) {
	h := NewHub()
	c := &fakeConn{}
	detach := h.Attach(1, c)
	detach()
	h.Publish(1, agentapi.LiveNetSample{RxBps: 1})
	if len(c.got) != 0 {
		t.Fatalf("got delivery after detach: %+v", c.got)
	}
}

func TestHub_DropsConnOnWriteError(t *testing.T) {
	h := NewHub()
	bad := &fakeConn{fail: true}
	_ = h.Attach(1, bad)
	h.Publish(1, agentapi.LiveNetSample{RxBps: 1})
	good := &fakeConn{}
	_ = h.Attach(1, good)
	h.Publish(1, agentapi.LiveNetSample{RxBps: 2})
	if len(good.got) == 0 {
		t.Fatal("good conn should still receive")
	}
}
