package agentapi

import (
	"bytes"
	"testing"
)

func TestBinaryFrame_RoundTrip(t *testing.T) {
	cases := []struct {
		sid     string
		kind    byte
		payload []byte
	}{
		{"abc", KindPTYOut, []byte("hello")},
		{"x", KindPTYIn, nil},
		{"YWJjZGVmZ2hpamtsbW5vcHFy", KindFileChunk, bytes.Repeat([]byte{0xff}, 1024)},
	}
	for _, c := range cases {
		buf, err := EncodeBinary(c.sid, c.kind, c.payload)
		if err != nil {
			t.Fatalf("encode %q: %v", c.sid, err)
		}
		sid, kind, payload, err := DecodeBinary(buf)
		if err != nil {
			t.Fatalf("decode %q: %v", c.sid, err)
		}
		if sid != c.sid || kind != c.kind || !bytes.Equal(payload, c.payload) {
			t.Fatalf("mismatch sid=%q kind=%x payload=%q", sid, kind, payload)
		}
	}
}

func TestBinaryFrame_Reject(t *testing.T) {
	if _, _, _, err := DecodeBinary([]byte{0x00}); err == nil {
		t.Fatalf("decode short header: want err")
	}
	if _, _, _, err := DecodeBinary([]byte{0x00, 0x05, 0x01, 'a', 'b'}); err == nil {
		t.Fatalf("decode short sid: want err")
	}
	if _, err := EncodeBinary(string(make([]byte, 65)), KindPTYOut, nil); err == nil {
		t.Fatalf("encode too-long sid: want err")
	}
}
