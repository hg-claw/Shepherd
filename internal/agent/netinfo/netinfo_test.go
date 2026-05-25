package netinfo

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
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

func TestFetchPublicIP_ParsesPlainText(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// ip.me + ipify both serve plain text; trailing newline is
		// standard. ParseIP needs the trim that fetchPublicIP does.
		_, _ = w.Write([]byte("203.0.113.42\n"))
	}))
	defer srv.Close()
	got := fetchPublicIP(context.Background(), srv.URL)
	if got != "203.0.113.42" {
		t.Errorf("fetchPublicIP = %q want 203.0.113.42", got)
	}
}

func TestFetchPublicIP_RejectsHTMLOrNonsense(t *testing.T) {
	// Some services serve an HTML page when User-Agent doesn't match
	// curl/wget. Defensive: ParseIP must reject; we already cap the body
	// at 64 bytes so a huge HTML response can't OOM.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("<html><body>not an IP</body></html>"))
	}))
	defer srv.Close()
	if got := fetchPublicIP(context.Background(), srv.URL); got != "" {
		t.Errorf("fetchPublicIP on HTML = %q want empty", got)
	}
}

func TestPublicIPv4_FallsThroughFailures(t *testing.T) {
	// Swap the probe list to a doomed primary + a working secondary.
	// Verifies the fall-through logic without hitting the real internet,
	// which is the actual production failure shape (ip.me blocked, the
	// second probe answers).
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(500)
	}))
	defer dead.Close()
	alive := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("198.51.100.7"))
	}))
	defer alive.Close()

	orig := publicProbes
	t.Cleanup(func() { publicProbes = orig })
	publicProbes = []struct{ name, url string }{
		{"dead", dead.URL},
		{"alive", alive.URL},
	}
	addr, src := publicIPv4(context.Background())
	if addr != "198.51.100.7" || src != "alive" {
		t.Errorf("got (%q, %q); want (198.51.100.7, alive)", addr, src)
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
