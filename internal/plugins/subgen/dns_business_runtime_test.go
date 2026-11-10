package subgen

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
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

	"golang.org/x/net/proxy"
	"gopkg.in/yaml.v3"
)

// TestBusinessDNSRuntime starts only a disposable, loopback-only core. It does
// not load a profile into the user's running proxy, change system DNS, or use
// public networking. The SOCKS client sends domain names rather than resolving
// them in the test process. Each step opens a new TCP connection; DNS-cache
// reuse on the final DIRECT step is intentional and must not affect routing.
//
// SHEPHERD_MIHOMO_BIN=/absolute/path/to/mihomo go test -race ./internal/plugins/subgen -run '^TestBusinessDNSRuntime$' -count=1 -v
//
// Scope: domain TCP and IP-rule prelookup followed by DIRECT re-resolution.
// This is not a claim about process discovery or remote DNS support for UDP.
func TestBusinessDNSRuntime(t *testing.T) {
	bin := os.Getenv("SHEPHERD_MIHOMO_BIN")
	if bin == "" {
		t.Skip("set SHEPHERD_MIHOMO_BIN to run isolated real-core business DNS tests")
	}
	bin, err := filepath.Abs(bin)
	if err != nil {
		t.Fatal(err)
	}
	var localQueries, remoteQueries, privacyConnects atomic.Int64
	local := privateDoH(t, &localQueries, "127.0.0.1", false)
	remote := privateDoH(t, &remoteQueries, "198.51.100.10", false)
	remoteAddress := strings.TrimPrefix(remote.URL, "https://")

	// Prove that the privacy DoH can be reached only through its own proxy.
	// Business A/B are deliberately different listeners and never forward DNS.
	var peerMu sync.Mutex
	privacyPeers := make(map[string]bool)
	remoteHandler := remote.Config.Handler
	remote.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peerMu.Lock()
		viaPrivacy := privacyPeers[r.RemoteAddr]
		peerMu.Unlock()
		if !viaPrivacy {
			t.Error("safe remote DoH bypassed PrivacyProxy")
		}
		remoteHandler.ServeHTTP(w, r)
	})
	privacy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		privacyConnects.Add(1)
		if r.Method != http.MethodConnect || r.Host != remoteAddress {
			t.Errorf("PrivacyProxy received business target %q", r.Host)
			http.Error(w, "only the private DoH is allowed", http.StatusBadGateway)
			return
		}
		upstream, err := net.DialTimeout("tcp", remoteAddress, time.Second)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		peerMu.Lock()
		privacyPeers[upstream.LocalAddr().String()] = true
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
	t.Cleanup(privacy.Close)

	targetsA, targetsB := make(chan string, 8), make(chan string, 8)
	newBusinessProxy := func(name string, targets chan<- string) *httptest.Server {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodConnect {
				http.Error(w, "CONNECT required", http.StatusMethodNotAllowed)
				return
			}
			targets <- r.Host
			client, rw, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			defer func() { _ = client.Close() }()
			_, _ = rw.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
			_ = rw.Flush()
			_ = client.SetDeadline(time.Now().Add(3 * time.Second))
			var payload [1]byte
			if _, err := io.ReadFull(rw, payload[:]); err != nil {
				return
			}
			_, _ = fmt.Fprintf(client, "%s\n", name)
		}))
		t.Cleanup(server.Close)
		return server
	}
	proxyA, proxyB := newBusinessProxy("ProxyA", targetsA), newBusinessProxy("ProxyB", targetsB)

	// An actual destination listener proves DIRECT used the domestic answer.
	// The remote answer is TEST-NET, so consuming that prelookup IP cannot pass.
	direct, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = direct.Close() })
	var directAccepts atomic.Int64
	go func() {
		for {
			conn, err := direct.Accept()
			if err != nil {
				return
			}
			directAccepts.Add(1)
			_, _ = io.WriteString(conn, "DIRECT\n")
			_ = conn.Close()
		}
	}()
	_, targetPort, _ := net.SplitHostPort(direct.Addr().String())

	// Start from the real opt-in renderer, not a second DNS configuration model.
	body := (&ClashRenderer{}).Render(Intermediate{DNSMode: DNSModeRuleAware}, "", "")
	doc := decodeRenderedClash(t, body)
	d := doc["dns"].(map[string]any)
	if _, ok := d["direct-nameserver"]; !ok {
		t.Fatal("rule-aware renderer must emit a native DIRECT resolver")
	}
	if policy, ok := d["nameserver-policy"].(map[string]any); ok && len(policy) != 0 {
		t.Fatal("rule-aware renderer must not preselect domestic DNS by static suffix")
	}
	d["listen"] = ""
	d["enhanced-mode"] = "fake-ip"
	d["use-hosts"], d["use-system-hosts"] = false, false
	d["ipv6"], d["prefer-h3"], d["respect-rules"] = false, false, false
	d["default-nameserver"] = []string{local.URL + "/dns-query"}
	d["proxy-server-nameserver"] = []string{local.URL + "/dns-query#DIRECT"}
	d["nameserver"] = []string{remote.URL + "/dns-query#Proxy"}
	d["direct-nameserver"] = []string{local.URL + "/dns-query#DIRECT"}
	d["direct-nameserver-follow-policy"] = false
	delete(d, "fallback")
	delete(d, "nameserver-policy")

	freeAddress := func() string {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		address := listener.Addr().String()
		_ = listener.Close()
		return address
	}
	socksAddress, controller := freeAddress(), freeAddress()
	_, socksPort, _ := net.SplitHostPort(socksAddress)
	port, _ := strconv.Atoi(socksPort)
	doc["port"], doc["mixed-port"], doc["socks-port"] = 0, 0, port
	doc["bind-address"], doc["allow-lan"] = "127.0.0.1", false
	doc["external-controller"], doc["secret"] = controller, ""
	doc["log-level"], doc["find-process-mode"] = "debug", "off"
	proxyEntry := func(name, rawURL string) map[string]any {
		host, rawPort, err := net.SplitHostPort(strings.TrimPrefix(rawURL, "http://"))
		if err != nil {
			t.Fatal(err)
		}
		port, _ := strconv.Atoi(rawPort)
		return map[string]any{"name": name, "type": "http", "server": host, "port": port}
	}
	doc["proxies"] = []any{proxyEntry("ProxyA", proxyA.URL), proxyEntry("ProxyB", proxyB.URL), proxyEntry("PrivacyProxy", privacy.URL)}
	doc["proxy-groups"] = []any{
		map[string]any{"name": "Proxy", "type": "select", "proxies": []string{"PrivacyProxy"}},
		map[string]any{"name": "Business", "type": "select", "proxies": []string{"DIRECT", "ProxyA", "ProxyB"}},
	}
	doc["rules"] = []string{
		"DOMAIN-SUFFIX,business.test,Business",
		"IP-CIDR,198.51.100.10/32,DIRECT",
		"MATCH,REJECT",
	}
	delete(doc, "rule-providers")
	delete(doc, "profile")
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
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, config, 0600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(dir, "core.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	command := exec.CommandContext(ctx, bin, "-d", dir, "-f", configPath)
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
			logs, _ := os.ReadFile(logPath)
			t.Logf("isolated business core: %s", logs)
		}
	})
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	client := &http.Client{Transport: transport, Timeout: 300 * time.Millisecond}
	deadline := time.Now().Add(5 * time.Second)
	ready := false
	for time.Now().Before(deadline) {
		response, err := client.Get("http://" + controller + "/version")
		if err == nil {
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				ready = true
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !ready {
		t.Fatal("isolated business core did not start")
	}
	setBusiness := func(name string) {
		encoded, _ := json.Marshal(map[string]string{"name": name})
		request, _ := http.NewRequest(http.MethodPut, "http://"+controller+"/proxies/Business", strings.NewReader(string(encoded)))
		request.Header.Set("Content-Type", "application/json")
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != http.StatusNoContent {
			data, _ := io.ReadAll(response.Body)
			t.Fatalf("select %s: HTTP %d %s", name, response.StatusCode, data)
		}
	}
	requestTarget := func(host, want string) {
		dialer, err := proxy.SOCKS5("tcp", socksAddress, nil, &net.Dialer{Timeout: 3 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		conn, err := dialer.Dial("tcp", net.JoinHostPort(host, targetPort))
		if err != nil {
			t.Fatalf("SOCKS domain request %s: %v", host, err)
		}
		defer func() { _ = conn.Close() }()
		_ = conn.SetDeadline(time.Now().Add(3 * time.Second))
		if _, err := conn.Write([]byte("x")); err != nil {
			t.Fatalf("write business payload: %v", err)
		}
		marker := make([]byte, len(want)+1)
		if _, err := io.ReadFull(conn, marker); err != nil || string(marker) != want+"\n" {
			t.Fatalf("%s: marker %q, want %q, error %v", host, marker, want, err)
		}
	}

	// A/B see the original domain even when the DIRECT DNS cache is warm.
	// Neither business step may consult the main Proxy or the privacy DoH.
	for _, selected := range []string{"DIRECT", "ProxyA", "ProxyB", "DIRECT"} {
		setBusiness(selected)
		requestTarget("same.business.test", selected)
		if remoteQueries.Load() != 0 || privacyConnects.Load() != 0 {
			t.Fatal("domain business routing consulted the unified privacy Proxy")
		}
	}
	for name, targets := range map[string]<-chan string{"ProxyA": targetsA, "ProxyB": targetsB} {
		select {
		case target := <-targets:
			if target != net.JoinHostPort("same.business.test", targetPort) {
				t.Fatalf("%s received %q instead of the original domain", name, target)
			}
		default:
			t.Fatalf("%s never received the business domain", name)
		}
	}
	if localQueries.Load() == 0 || directAccepts.Load() != 2 {
		t.Fatalf("DIRECT path missing: local DNS=%d accepts=%d", localQueries.Load(), directAccepts.Load())
	}

	// This unknown domain reaches an IP rule before a final outbound is known.
	// It must use the safe remote answer for matching, then replace that IP via
	// the domestic DIRECT resolver. A DNS-query-only test cannot prove this.
	localBefore := localQueries.Load()
	requestTarget("unknown.prelookup.test", "DIRECT")
	if localQueries.Load() <= localBefore || remoteQueries.Load() == 0 || privacyConnects.Load() == 0 || directAccepts.Load() != 3 {
		t.Fatalf("prelookup/reselect failed: local=%d->%d remote=%d privacy=%d direct=%d", localBefore, localQueries.Load(), remoteQueries.Load(), privacyConnects.Load(), directAccepts.Load())
	}
}
