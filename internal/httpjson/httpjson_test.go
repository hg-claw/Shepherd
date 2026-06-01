package httpjson

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func TestWrite(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, 201, map[string]int{"n": 7})
	if w.Code != 201 {
		t.Fatalf("code=%d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type=%q", ct)
	}
	var got map[string]int
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil || got["n"] != 7 {
		t.Fatalf("body=%q err=%v", w.Body.String(), err)
	}
}

func TestWriteNilBodyNoEncode(t *testing.T) {
	w := httptest.NewRecorder()
	Write(w, 204, nil)
	if w.Body.Len() != 0 {
		t.Fatalf("nil body should not encode, got %q", w.Body.String())
	}
}

func TestError(t *testing.T) {
	w := httptest.NewRecorder()
	Error(w, 400, "bad input")
	if w.Code != 400 {
		t.Fatalf("code=%d", w.Code)
	}
	var got map[string]string
	_ = json.Unmarshal(w.Body.Bytes(), &got)
	if got["error"] != "bad input" {
		t.Fatalf("body=%q", w.Body.String())
	}
}
