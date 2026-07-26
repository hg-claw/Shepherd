package singbox

import "testing"

func TestSingboxMinorAtLeast(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"1.14.0", true},
		{"v1.14.0", true},
		{"1.14.0-beta.2", true},
		{"v1.14.0-beta.2", true},
		{"1.15.3", true},
		{"2.0.0", true},
		{"1.13.14", false},
		{"1.13.12", false},
		{"1.9.0", false},
		{"", false},
		{"garbage", false},
	}
	for _, c := range cases {
		if got := singboxMinorAtLeast(c.version, 1, 14); got != c.want {
			t.Errorf("singboxMinorAtLeast(%q, 1, 14) = %v, want %v", c.version, got, c.want)
		}
	}
}

func TestRequiresSingbox114(t *testing.T) {
	if !requiresSingbox114("snell-v5") || !requiresSingbox114("snell-v6") {
		t.Error("snell protocols must require 1.14")
	}
	if requiresSingbox114("hysteria2") || requiresSingbox114("vless-reality") {
		t.Error("non-snell protocols must not require 1.14")
	}
}
