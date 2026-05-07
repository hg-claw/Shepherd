package agentsvc

import (
	"errors"
	"sync"
	"time"
)

var ErrSlowConsumer = errors.New("ws conn slow consumer")
var ErrConnClosed = errors.New("ws conn closed")

// OutFrame is what gets written to the underlying ws — exactly one of Text/Binary set.
type OutFrame struct {
	Text   []byte // non-nil → text message
	Binary []byte // non-nil → binary message
}

// RawWriter is implemented by gorilla websocket.Conn (via a thin adapter).
type RawWriter interface {
	WriteFrame(OutFrame) error
	Close() error
}

type WSConn struct {
	raw       RawWriter
	sendCh    chan OutFrame
	enqWait   time.Duration
	closeOnce sync.Once
	done      chan struct{}
}

func NewWSConn(raw RawWriter, queue int, enqWait time.Duration) *WSConn {
	c := &WSConn{
		raw:     raw,
		sendCh:  make(chan OutFrame, queue),
		enqWait: enqWait,
		done:    make(chan struct{}),
	}
	go c.writeLoop()
	return c
}

func (c *WSConn) writeLoop() {
	for f := range c.sendCh {
		if err := c.raw.WriteFrame(f); err != nil {
			_ = c.raw.Close()
			break
		}
	}
}

func (c *WSConn) Send(f OutFrame) error {
	select {
	case <-c.done:
		return ErrConnClosed
	default:
	}
	t := time.NewTimer(c.enqWait)
	defer t.Stop()
	select {
	case c.sendCh <- f:
		return nil
	case <-t.C:
		c.Close()
		return ErrSlowConsumer
	case <-c.done:
		return ErrConnClosed
	}
}

func (c *WSConn) Close() {
	c.closeOnce.Do(func() {
		close(c.done)
		close(c.sendCh)
		_ = c.raw.Close()
	})
}
