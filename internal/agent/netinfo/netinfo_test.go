package netinfo

import (
	"context"
	"net"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct{ ip, ifName, want string }{
		{"10.0.0.1", "en0", "private"},
		{"192.168.1.5", "wlan0", "private"},
		{"172.16.0.1", "eth0", "private"},
		{"100.64.0.5", "en0", "cgnat"},
		{"198.18.0.1", "utun4", "vpn"},
		{"198.19.0.1", "en0", "vpn"},
		{"10.0.0.1", "wg0", "vpn"}, // wg iface always vpn
		{"23.249.27.181", "en0", "public"},
		{"127.0.0.1", "lo", ""},
		{"169.254.1.1", "en0", ""},  // link-local
		{"192.0.2.1", "en0", ""},    // TEST-NET-1
		{"198.51.100.1", "en0", ""}, // TEST-NET-2
		{"203.0.113.1", "en0", ""},  // TEST-NET-3
	}
	for _, c := range cases {
		ip := net.ParseIP(c.ip).To4()
		if ip == nil {
			t.Fatalf("bad test ip %q", c.ip)
		}
		got := classify(ip, c.ifName)
		if got != c.want {
			t.Errorf("classify(%s, %s) = %q want %q", c.ip, c.ifName, got, c.want)
		}
	}
}

func TestCollect_Smoke(t *testing.T) {
	cands := Collect(context.Background())
	// On any reasonable dev/CI machine there will be at least one interface address
	// (unless all are filtered). We just assert that no panics occur and the result
	// is well-formed.
	for _, c := range cands {
		if c.Addr == "" {
			t.Errorf("empty addr in candidate %+v", c)
		}
		switch c.Kind {
		case "public", "private", "cgnat", "vpn":
		default:
			t.Errorf("unexpected kind %q in candidate %+v", c.Kind, c)
		}
		if c.Source == "" {
			t.Errorf("empty source in candidate %+v", c)
		}
	}
	t.Logf("collected %d candidates", len(cands))
}
