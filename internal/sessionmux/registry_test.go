package sessionmux

import (
	"sync"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

func TestRegistry_PTYDeliver(t *testing.T) {
	r := New()
	got := make(chan []byte, 1)
	r.RegisterPTY("sid1", &fakePTY{onBinary: func(p []byte) { got <- p }})
	if !r.DeliverBinary("sid1", agentapi.KindPTYOut, []byte("xyz")) {
		t.Fatal("not delivered")
	}
	select {
	case b := <-got:
		if string(b) != "xyz" {
			t.Fatalf("got %q", b)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

func TestRegistry_RequestReply(t *testing.T) {
	r := New()
	ch := r.RegisterRequest("sid2")
	defer r.Unregister("sid2")
	go func() {
		r.Deliver(agentapi.Envelope{Sid: "sid2", Type: "file.list.result", P: []byte(`{"sid":"sid2"}`)})
	}()
	select {
	case env := <-ch:
		if env.Type != "file.list.result" {
			t.Fatalf("type=%q", env.Type)
		}
	case <-time.After(time.Second):
		t.Fatal("timeout")
	}
}

func TestRegistry_UnknownSidDropped(t *testing.T) {
	r := New()
	if r.DeliverBinary("nosuch", 0x01, []byte("x")) {
		t.Fatal("unknown sid delivered")
	}
	if r.Deliver(agentapi.Envelope{Sid: "nosuch", Type: "x"}) {
		t.Fatal("unknown sid delivered (text)")
	}
}

type fakePTY struct {
	mu       sync.Mutex
	onBinary func([]byte)
}

func (f *fakePTY) DeliverBinary(_ byte, p []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.onBinary(p)
}
func (f *fakePTY) DeliverControl(_ agentapi.Envelope) {}
