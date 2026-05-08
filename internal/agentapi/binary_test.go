package agentapi

import (
	"bytes"
	"errors"
	"testing"
)

func TestBinaryFrame_RoundTrip(t *testing.T) {
	cases := []struct {
		sid     string
		kind    byte
		payload []byte
	}{
		{"abc", KindPTYOut, []byte("hello")},
		{"hello", KindPTYOut, []byte{}},
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
		// bytes.Equal treats nil and []byte{} as equal, so this handles the
		// empty-payload case where DecodeBinary may return a nil or empty slice.
		if sid != c.sid || kind != c.kind || !bytes.Equal(payload, c.payload) {
			t.Fatalf("mismatch sid=%q kind=%x payload=%q", sid, kind, payload)
		}
	}
}

func TestBinaryFrame_Reject(t *testing.T) {
	if _, _, _, err := DecodeBinary([]byte{0x00}); !errors.Is(err, ErrShortFrame) {
		t.Fatalf("decode short header: want ErrShortFrame, got %v", err)
	}
	if _, _, _, err := DecodeBinary([]byte{0x00, 0x05, 0x01, 'a', 'b'}); !errors.Is(err, ErrShortFrame) {
		t.Fatalf("decode short sid: want ErrShortFrame, got %v", err)
	}
	if _, err := EncodeBinary(string(make([]byte, 65)), KindPTYOut, nil); !errors.Is(err, ErrSidTooLong) {
		t.Fatalf("encode too-long sid: want ErrSidTooLong, got %v", err)
	}
}
