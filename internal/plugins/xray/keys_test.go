package xray

import (
	"encoding/base64"
	"testing"
)

func TestGenerateX25519_Format(t *testing.T) {
	priv, pub, err := GenerateX25519()
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{priv, pub} {
		b, err := base64.RawURLEncoding.DecodeString(k)
		if err != nil {
			t.Fatalf("not raw-url: %v / %q", err, k)
		}
		if len(b) != 32 {
			t.Fatalf("expected 32B, got %d", len(b))
		}
	}
}

func TestGenerateShortID(t *testing.T) {
	id, err := GenerateShortID()
	if err != nil {
		t.Fatal(err)
	}
	if len(id) != 16 {
		t.Fatalf("len = %d", len(id))
	}
}
