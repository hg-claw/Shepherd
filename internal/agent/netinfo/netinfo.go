package netinfo

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

type Candidate struct {
	Addr   string
	Kind   string
	Source string
}

// Collect returns IPv4 candidates from local interfaces plus, when reachable,
// a single public IPv4 from an external probe. Filters loopback, link-local,
// multicast, documentation / test ranges. Classifies private RFC1918, CGNAT
// 100.64/10, and 198.18/15 as 'vpn' (catches utun4=198.18.0.1).
//
// Why probe externally at all: 1:1 NAT setups (EC2-style elastic IP, GCP
// static external IP, most Tencent / Aliyun VMs in China) leave the host's
// interface holding only the private/CGNAT side — the public IP is never
// visible to the kernel. Without a probe the SSH host auto-pick falls
// through to a private address and dial-back fails.
func Collect(ctx context.Context) []Candidate {
	out := []Candidate{}
	ifs, _ := net.Interfaces()
	for _, ifc := range ifs {
		if ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		if ifc.Flags&net.FlagUp == 0 {
			continue
		}
		name := ifc.Name
		// Skip container-ish virtual interfaces.
		if strings.HasPrefix(name, "docker") || strings.HasPrefix(name, "br-") ||
			strings.HasPrefix(name, "veth") || strings.HasPrefix(name, "cni") {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipnet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipnet.IP.To4()
			if ip == nil {
				continue
			}
			kind := classify(ip, name)
			if kind == "" {
				continue
			}
			out = append(out, Candidate{Addr: ip.String(), Kind: kind, Source: name})
		}
	}
	if pub, src := publicIPv4(ctx); pub != "" {
		out = append([]Candidate{{Addr: pub, Kind: "public", Source: src}}, out...)
	}
	return out
}

func classify(ip net.IP, ifName string) string {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsMulticast() {
		return ""
	}
	if strings.HasPrefix(ifName, "utun") || strings.HasPrefix(ifName, "tun") ||
		strings.HasPrefix(ifName, "tap") || strings.HasPrefix(ifName, "wg") {
		return "vpn"
	}
	// 198.18.0.0/15 — benchmarking; often used by NextDNS / Tailscale magic IPs
	if ip[0] == 198 && (ip[1] == 18 || ip[1] == 19) {
		return "vpn"
	}
	// RFC1918
	if ip[0] == 10 ||
		(ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31) ||
		(ip[0] == 192 && ip[1] == 168) {
		return "private"
	}
	// CGNAT 100.64.0.0/10
	if ip[0] == 100 && ip[1] >= 64 && ip[1] <= 127 {
		return "cgnat"
	}
	// Documentation / test ranges
	if ip[0] == 192 && ip[1] == 0 && ip[2] == 2 {
		return ""
	}
	if ip[0] == 198 && ip[1] == 51 && ip[2] == 100 {
		return ""
	}
	if ip[0] == 203 && ip[1] == 0 && ip[2] == 113 {
		return ""
	}
	return "public"
}

// publicProbes lists external IP-echo services tried in order. ip.me
// fronts the list because it's reachable from mainland China where ipify
// is frequently throttled or blocked at the GFW; ipify stays as a
// well-known backup, and icanhazip is a second backup with a different
// upstream so a single CDN outage doesn't take all three down.
// All three return a bare IPv4 address as plain text, no JSON parsing.
var publicProbes = []struct{ name, url string }{
	{"ip.me", "https://ip.me/"},
	{"ipify", "https://api.ipify.org"},
	{"icanhazip", "https://ipv4.icanhazip.com"},
}

// publicIPv4 tries each probe in order, short-circuiting on the first
// success. Returns the address + which probe answered (for diagnostics
// surfaced via Candidate.Source).
func publicIPv4(ctx context.Context) (string, string) {
	for _, p := range publicProbes {
		if addr := fetchPublicIP(ctx, p.url); addr != "" {
			return addr, p.name
		}
	}
	return "", ""
}

func fetchPublicIP(ctx context.Context, url string) string {
	// Per-probe deadline keeps a single slow service from eating the
	// whole boot window. Total walltime budget across all probes is
	// roughly len(publicProbes) × this value.
	c, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, "GET", url, nil)
	// ip.me + ifconfig-style services return plain text only when the
	// User-Agent looks like curl/wget; otherwise they serve an HTML
	// page. ipify ignores the header so this is safe to send universally.
	req.Header.Set("User-Agent", "shepherd-agent/1 (+netinfo)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return ""
	}
	// Cap body — defensive against an upstream change that serves a full
	// HTML page (would otherwise pull MB into memory just to ParseIP-fail).
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64))
	addr := strings.TrimSpace(string(b))
	if net.ParseIP(addr) == nil {
		return ""
	}
	return addr
}
