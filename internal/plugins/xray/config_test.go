package xray

import (
	"strings"
	"testing"
)

func TestNormaliseRaw_AcceptsValidJSON(t *testing.T) {
	out, err := NormaliseRaw([]byte(`{"inbounds":[],"outbounds":[]}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"inbounds"`) {
		t.Fatalf("output lost inbounds: %s", out)
	}
}

func TestNormaliseRaw_RejectsInvalidJSON(t *testing.T) {
	_, err := NormaliseRaw([]byte(`not json`))
	if err == nil {
		t.Fatal("expected error")
	}
}
