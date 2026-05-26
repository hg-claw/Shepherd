package ptysvc

import (
	"path/filepath"
	"testing"
	"time"
)

func TestExtractLog_ConcatenatesOutputEvents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "5.cast")
	w, err := NewCastWriter(path, 80, 24, time.Unix(0, 0), "shepherd-pty", "kind=script")
	if err != nil {
		t.Fatal(err)
	}
	w.WriteOutput(10*time.Millisecond, []byte("hello "))
	w.WriteOutput(20*time.Millisecond, []byte("world\n"))
	w.WriteOutput(30*time.Millisecond, []byte("exit 0\n"))
	_ = w.Close()

	got, err := ExtractLog(path)
	if err != nil {
		t.Fatal(err)
	}
	want := "hello world\nexit 0\n"
	if got != want {
		t.Errorf("ExtractLog = %q, want %q", got, want)
	}
}

func TestExtractLog_SkipsHeaderAndNonOutput(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "6.cast")
	w, _ := NewCastWriter(path, 80, 24, time.Unix(0, 0), "c", "")
	w.WriteOutput(time.Second, []byte("output line"))
	_ = w.Close()

	got, err := ExtractLog(path)
	if err != nil {
		t.Fatal(err)
	}
	// Header line must not leak into the log; only the "o" event remains.
	if got != "output line" {
		t.Errorf("ExtractLog = %q, want %q", got, "output line")
	}
}

func TestExtractLog_MissingFile(t *testing.T) {
	if _, err := ExtractLog(filepath.Join(t.TempDir(), "nope.cast")); err == nil {
		t.Fatal("expected error for missing file")
	}
}
