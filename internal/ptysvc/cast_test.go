package ptysvc

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCastWriter_Format(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "rec.cast")
	w, err := NewCastWriter(path, 80, 24, time.Now(), "/bin/bash -l", "test")
	if err != nil {
		t.Fatal(err)
	}
	w.WriteOutput(100*time.Millisecond, []byte("hello"))
	w.WriteOutput(250*time.Millisecond, []byte("\nworld"))
	_ = w.Close()

	f, _ := os.Open(path)
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	sc.Scan()
	var hdr map[string]any
	if err := json.Unmarshal([]byte(sc.Text()), &hdr); err != nil {
		t.Fatal(err)
	}
	if hdr["version"].(float64) != 2 {
		t.Fatalf("version=%v", hdr["version"])
	}
	if hdr["width"].(float64) != 80 {
		t.Fatalf("width=%v", hdr["width"])
	}
	var lines []string
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	if len(lines) != 2 {
		t.Fatalf("events=%d", len(lines))
	}
	if !strings.Contains(lines[0], `"o"`) || !strings.Contains(lines[0], "hello") {
		t.Fatalf("event 0: %s", lines[0])
	}
}

func TestCastWriter_Cap(t *testing.T) {
	dir := t.TempDir()
	w, _ := NewCastWriter(filepath.Join(dir, "big.cast"), 80, 24, time.Now(), "x", "")
	w.SetMaxBytes(1024)
	for i := 0; i < 100; i++ {
		w.WriteOutput(time.Duration(i)*time.Millisecond, []byte(strings.Repeat("a", 50)))
	}
	_ = w.Close()
	if !w.Truncated() {
		t.Fatal("expected truncated=true")
	}
}
