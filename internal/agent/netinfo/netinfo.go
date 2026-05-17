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
// a single public IPv4 from ipify. Filters loopback, link-local, multicast,
// documentation / test ranges. Classifies private RFC1918, CGNAT 100.64/10,
// and 198.18/15 as 'vpn' (catches utun4=198.18.0.1).
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
	if pub := publicIPv4(ctx); pub != "" {
		out = append([]Candidate{{Addr: pub, Kind: "public", Source: "ipify"}}, out...)
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

func publicIPv4(ctx context.Context) string {
	c, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(c, "GET", "https://api.ipify.org", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return ""
	}
	b, _ := io.ReadAll(resp.Body)
	addr := strings.TrimSpace(string(b))
	if net.ParseIP(addr) == nil {
		return ""
	}
	return addr
}
