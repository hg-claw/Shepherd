package api

import (
	"context"
	"io"
	"testing"
	"time"
)

func TestPreviewRead_ReturnsPrefixAndCancels(t *testing.T) {
	cancelled := make(chan struct{})
	downloadFn := func(ctx context.Context, w io.Writer) error {
		_, _ = w.Write([]byte("hello world more than five")) // pipe write blocks past 5 bytes
		<-ctx.Done()                                          // unblocked only when previewRead cancels us
		close(cancelled)
		return ctx.Err()
	}
	data := previewRead(context.Background(), 5, downloadFn)
	if string(data) != "hello" {
		t.Fatalf("data=%q want %q", data, "hello")
	}
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("download ctx not cancelled after previewRead returned (leak)")
	}
}
