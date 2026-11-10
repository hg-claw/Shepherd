package subgen

import (
	"context"
	"encoding/base64"
	"encoding/pem"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/miekg/dns"
	"gopkg.in/yaml.v3"
)

// This optional integration test only starts a separate loopback core. It never
// loads a profile into the user's running proxy, changes DNS, or uses the public
// network. Run with SHEPHERD_MIHOMO_BIN=/path/to/mihomo go test -race ... .
func TestPrivateDNSRuntime(t *testing.T) {
	bin := os.Getenv("SHEPHERD_MIHOMO_BIN")
	if bin == "" {
		t.Skip("set SHEPHERD_MIHOMO_BIN to run isolated real-core DNS tests")
	}
	absolute, err := filepath.Abs(bin)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"routes", "proxy-unavailable", "remote-dns-unavailable", "domestic-dns-unavailable"} {
		t.Run(scenario, func(t *testing.T) {
			h := newPrivateDNSRuntime(t, absolute, scenario)
			switch scenario {
			case "routes":
				for _, host := range []string{"taobao.com", "a.b.taobao.com", "gw.alicdn.com"} {
					h.expect(host, "192.0.2.10")
				}
				for _, host := range []string{"example.net", "unlisted.cn", "nottaobao.com", "vv.video.qq.com"} {
					h.expect(host, "198.51.100.10")
				}
				if h.localQueries.Load() != 3 || h.remoteQueries.Load() != 4 || h.connects.Load() == 0 {
					t.Fatalf("wrong resolver path: local=%d remote=%d proxy=%d", h.localQueries.Load(), h.remoteQueries.Load(), h.connects.Load())
				}
			case "proxy-unavailable", "remote-dns-unavailable":
				h.expectFailure("unknown-failure.example.net")
				if h.localQueries.Load() != 0 || h.connects.Load() == 0 {
					t.Fatal("private DNS failure used domestic fallback or never attempted proxy")
				}
			case "domestic-dns-unavailable":
				h.expectFailure("failure.taobao.com")
				if h.localQueries.Load() == 0 || h.remoteQueries.Load() != 0 || h.connects.Load() != 0 {
					t.Fatal("domestic failure switched to private default instead of failing")
				}
			}
		})
	}
}

type privateDNSRuntime struct {
	t             *testing.T
	address       string
	localQueries  atomic.Int64
	remoteQueries atomic.Int64
	connects      atomic.Int64
}

func (h *privateDNSRuntime) exchange(host string) (*dns.Msg, error) {
	msg := new(dns.Msg)
	msg.SetQuestion(dns.Fqdn(host), dns.TypeA)
	client := &dns.Client{Net: "udp", Timeout: 3 * time.Second}
	response, _, err := client.Exchange(msg, h.address)
	return response, err
}

func (h *privateDNSRuntime) expect(host, ip string) {
	h.t.Helper()
	response, err := h.exchange(host)
	if err != nil {
		h.t.Fatalf("query %s: %v", host, err)
	}
	if response.Rcode != dns.RcodeSuccess {
		h.t.Fatalf("query %s failed: %s", host, response.String())
	}
	for _, answer := range response.Answer {
		if a, ok := answer.(*dns.A); ok && a.A.String() == ip {
			return
		}
	}
	h.t.Fatalf("%s did not use expected resolver %s: %s", host, ip, response.String())
}

func (h *privateDNSRuntime) expectFailure(host string) {
	h.t.Helper()
	response, err := h.exchange(host)
	if err == nil && response.Rcode == dns.RcodeSuccess && len(response.Answer) > 0 {
		h.t.Fatalf("query unexpectedly succeeded: %s", host)
	}
}

func privateDoH(t *testing.T, count *atomic.Int64, ip string, fail bool) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		if fail {
			http.Error(w, "test resolver unavailable", http.StatusServiceUnavailable)
			return
		}
		var wire []byte
		var err error
		if r.Method == http.MethodGet {
			wire, err = base64.RawURLEncoding.DecodeString(r.URL.Query().Get("dns"))
		} else {
			wire, err = io.ReadAll(io.LimitReader(r.Body, 65536))
		}
		query := new(dns.Msg)
		if err != nil || query.Unpack(wire) != nil || len(query.Question) != 1 {
			http.Error(w, "invalid DNS query", http.StatusBadRequest)
			return
		}
		response := new(dns.Msg)
		response.SetReply(query)
		response.Answer = []dns.RR{&dns.A{Hdr: dns.RR_Header{Name: query.Question[0].Name, Rrtype: dns.TypeA, Class: dns.ClassINET, Ttl: 1}, A: net.ParseIP(ip)}}
		encoded, err := response.Pack()
		if err != nil {
			http.Error(w, "pack error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/dns-message")
		_, _ = w.Write(encoded)
	}))
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func newPrivateDNSRuntime(t *testing.T, bin, scenario string) *privateDNSRuntime {
	t.Helper()
	h := &privateDNSRuntime{t: t}
	local := privateDoH(t, &h.localQueries, "192.0.2.10", scenario == "domestic-dns-unavailable")
	remote := privateDoH(t, &h.remoteQueries, "198.51.100.10", scenario == "remote-dns-unavailable")
	remoteAddress := strings.TrimPrefix(remote.URL, "https://")
	var peerMu sync.Mutex
	proxyPeers := make(map[string]bool)
	originalHandler := remote.Config.Handler
	remote.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peerMu.Lock()
		viaProxy := proxyPeers[r.RemoteAddr]
		peerMu.Unlock()
		if !viaProxy {
			t.Error("remote DoH was reached without its explicit proxy")
		}
		originalHandler.ServeHTTP(w, r)
	})
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h.connects.Add(1)
		if r.Method != http.MethodConnect || r.Host != remoteAddress || scenario == "proxy-unavailable" {
			http.Error(w, "test proxy unavailable", http.StatusBadGateway)
			return
		}
		upstream, err := net.DialTimeout("tcp", remoteAddress, time.Second)
		if err != nil {
			http.Error(w, "test upstream unavailable", http.StatusBadGateway)
			return
		}
		peerMu.Lock()
		proxyPeers[upstream.LocalAddr().String()] = true
		peerMu.Unlock()
		client, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			_ = upstream.Close()
			return
		}
		defer func() { _ = client.Close() }()
		defer func() { _ = upstream.Close() }()
		_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = rw.Flush()
		done := make(chan struct{})
		go func() {
			_, _ = io.Copy(upstream, rw)
			_ = upstream.Close()
			close(done)
		}()
		_, _ = io.Copy(client, upstream)
		_ = client.Close()
		<-done
	}))
	t.Cleanup(proxy.Close)
	proxyHost, proxyPort, err := net.SplitHostPort(strings.TrimPrefix(proxy.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(proxyPort)
	if err != nil {
		t.Fatal(err)
	}
	// Render the real default scope, then replace transport endpoints/listeners
	// for isolation. This test does not claim to exercise external business sets.
	body := (&ClashRenderer{}).Render(Intermediate{Nodes: []Node{{Name: "n", Protocol: "trojan", Server: "192.0.2.1", Port: 443, Password: "test"}}}, "", "")
	doc := decodeRenderedClash(t, body)
	d := doc["dns"].(map[string]any)
	if _, exists := d["direct-nameserver"]; exists {
		t.Fatal("global DIRECT resolver would bypass private defaults")
	}
	listener, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.address = listener.LocalAddr().String()
	_ = listener.Close()
	d["listen"], d["enhanced-mode"] = h.address, "redir-host"
	d["use-hosts"], d["use-system-hosts"] = false, false
	d["default-nameserver"] = []string{local.URL + "/dns-query"}
	d["proxy-server-nameserver"] = []string{local.URL + "/dns-query#DIRECT"}
	d["nameserver"] = []string{remote.URL + "/dns-query#Proxy"}
	policy := d["nameserver-policy"].(map[string]any)
	for key := range policy {
		policy[key] = []string{local.URL + "/dns-query#DIRECT"}
	}
	for _, key := range []string{"port", "socks-port", "mixed-port"} {
		doc[key] = 0
	}
	doc["external-controller"], doc["allow-lan"], doc["log-level"] = "", false, "warning"
	doc["proxies"] = []any{map[string]any{"name": "LoopProxy", "type": "http", "server": proxyHost, "port": port}}
	doc["proxy-groups"] = []any{map[string]any{"name": "Proxy", "type": "select", "proxies": []string{"LoopProxy"}}}
	doc["rules"] = []string{"MATCH,REJECT"}
	delete(doc, "rule-providers")
	var certs []string
	for _, server := range []*httptest.Server{local, remote} {
		certs = append(certs, string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw})))
	}
	doc["tls"] = map[string]any{"custom-certifactes": certs}
	config, err := yaml.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, config, 0600); err != nil {
		t.Fatal(err)
	}
	logFile, err := os.Create(filepath.Join(dir, "core.log"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	command := exec.CommandContext(ctx, bin, "-d", dir, "-f", path)
	command.Stdout, command.Stderr = logFile, logFile
	if err := command.Start(); err != nil {
		cancel()
		_ = logFile.Close()
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	t.Cleanup(func() {
		cancel()
		<-finished
		_ = logFile.Close()
		if t.Failed() {
			logs, _ := os.ReadFile(logFile.Name())
			t.Logf("isolated core: %s", logs)
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		connection, err := net.DialTimeout("tcp", h.address, 100*time.Millisecond)
		if err == nil {
			_ = connection.Close()
			return h
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("isolated DNS listener did not start at %s", h.address)
	return nil
}
