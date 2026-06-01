package agentsvc

import (
	"errors"
	"sync"
	"testing"
	"time"
)

type fakeRaw struct {
	mu     sync.Mutex
	frames []OutFrame
	block  chan struct{} // when non-nil, Write blocks until closed
}

func (f *fakeRaw) WriteFrame(of OutFrame) error {
	if f.block != nil {
		<-f.block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.frames = append(f.frames, of)
	return nil
}
func (f *fakeRaw) Close() error { return nil }

func TestWSConn_QueuesFrames(t *testing.T) {
	r := &fakeRaw{}
	c := NewWSConn(r, 8, 100*time.Millisecond)
	defer c.Close()
	for i := 0; i < 4; i++ {
		if err := c.Send(OutFrame{Text: []byte("a")}); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		n := len(r.frames)
		r.mu.Unlock()
		if n == 4 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	t.Fatalf("frames=%d want 4", len(r.frames))
}

func TestWSConn_SlowConsumerError(t *testing.T) {
	r := &fakeRaw{block: make(chan struct{})}
	c := NewWSConn(r, 1, 50*time.Millisecond)
	defer func() { close(r.block); c.Close() }()
	// First fills queue (cap 1), goes to writer goroutine immediately and blocks there.
	_ = c.Send(OutFrame{Text: []byte("a")})
	time.Sleep(10 * time.Millisecond)
	// Second waits for queue slot — writer is blocked on raw.
	_ = c.Send(OutFrame{Text: []byte("b")})
	// Third should time out → ErrSlowConsumer
	err := c.Send(OutFrame{Text: []byte("c")})
	if !errors.Is(err, ErrSlowConsumer) {
		t.Fatalf("err=%v want ErrSlowConsumer", err)
	}
}

func TestWSConn_ConcurrentSendCloseNoPanic(t *testing.T) {
	// With the old `close(sendCh)` in Close, a concurrent Send racing Close
	// panics ("send on closed channel"), crashing the test binary. The fix must
	// survive many iterations of the race.
	for i := 0; i < 300; i++ {
		c := NewWSConn(&fakeRaw{}, 4, time.Second)
		var wg sync.WaitGroup
		for s := 0; s < 8; s++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for j := 0; j < 20; j++ {
					_ = c.Send(OutFrame{Text: []byte("x")})
				}
			}()
		}
		go c.Close()
		wg.Wait()
		c.Close()
	}
}

func TestWSConn_SendAfterCloseReturnsClosed(t *testing.T) {
	c := NewWSConn(&fakeRaw{}, 4, time.Second)
	c.Close()
	if err := c.Send(OutFrame{Text: []byte("x")}); !errors.Is(err, ErrConnClosed) {
		t.Fatalf("send after close: err=%v want ErrConnClosed", err)
	}
}
