package agentsvc

import (
	"errors"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type fakeConn struct {
	sent   []agentapi.Envelope
	closed bool
	fail   error
}

func (f *fakeConn) Send(e agentapi.Envelope) error {
	if f.fail != nil {
		return f.fail
	}
	f.sent = append(f.sent, e)
	return nil
}
func (f *fakeConn) SendBinary([]byte) error { return nil }
func (f *fakeConn) Close() error            { f.closed = true; return nil }

func TestHub_RegisterReplacesPrev(t *testing.T) {
	h := NewHub()
	c1 := &fakeConn{}
	c2 := &fakeConn{}
	if prev := h.Register(7, c1); prev != nil {
		t.Errorf("first register prev=%v", prev)
	}
	prev := h.Register(7, c2)
	if prev != c1 {
		t.Errorf("second register prev mismatch")
	}
}

func TestHub_SendDelivers(t *testing.T) {
	h := NewHub()
	c := &fakeConn{}
	h.Register(7, c)
	env, _ := agentapi.Frame("ping", struct{}{})
	if err := h.Send(7, env); err != nil {
		t.Fatal(err)
	}
	if len(c.sent) != 1 || c.sent[0].Type != "ping" {
		t.Fatalf("sent=%+v", c.sent)
	}
}

func TestHub_SendOffline(t *testing.T) {
	h := NewHub()
	env, _ := agentapi.Frame("ping", struct{}{})
	if err := h.Send(99, env); !errors.Is(err, ErrAgentOffline) {
		t.Fatalf("err=%v", err)
	}
}

func TestHub_UnregisterOnlyIfCurrent(t *testing.T) {
	h := NewHub()
	c1 := &fakeConn{}
	c2 := &fakeConn{}
	h.Register(7, c1)
	h.Register(7, c2)
	h.Unregister(7, c1) // stale; should NOT remove c2
	if !h.IsOnline(7) {
		t.Error("stale unregister evicted current conn")
	}
	h.Unregister(7, c2)
	if h.IsOnline(7) {
		t.Error("real unregister failed")
	}
}

func TestHub_SendBinary(t *testing.T) {
	h := NewHub()
	got := make(chan []byte, 1)
	h.Register(7, &binaryRecorder{ch: got})
	if err := h.SendBinary(7, "abc", 0x01, []byte("hi")); err != nil {
		t.Fatal(err)
	}
	select {
	case b := <-got:
		// expect [00 03][01]['a''b''c']['h''i']
		if string(b) != "\x00\x03\x01abchi" {
			t.Fatalf("payload=%q", b)
		}
	case <-time.After(time.Second):
		t.Fatal("no frame")
	}
}

type binaryRecorder struct {
	ch chan []byte
}

func (r *binaryRecorder) Send(_ agentapi.Envelope) error { return nil }
func (r *binaryRecorder) SendBinary(b []byte) error      { r.ch <- b; return nil }
func (r *binaryRecorder) Close() error                   { return nil }
