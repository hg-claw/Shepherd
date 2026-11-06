package subgen

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestSurge_DNSUsesDedicatedProxyAndExactBootstrap(t *testing.T) {
	im := Intermediate{Nodes: []Node{
		{Name: "domain-node", Protocol: "trojan", Server: "edge.example", Port: 443, Password: "p", SNI: "edge.example"},
		{Name: "ip-node", Protocol: "trojan", Server: "192.0.2.1", Port: 443, Password: "p", SNI: "edge.example"},
	}}
	out := (&SurgeRenderer{}).Render(im, "https://example.com/sub/test", "")
	for _, want := range []string{
		"encrypted-dns-server = " + primaryDoH,
		"encrypted-dns-follow-outbound-mode = true",
		"Shepherd-DNS = select, domain-node, ip-node\n",
		"PROTOCOL,DOH,Shepherd-DNS\n",
		"edge.example = server:223.5.5.5\n",
		"hijack-dns = *:53\n",
		"Domestic = select, Direct, Proxy",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, forbidden := range []string{"dns-server = system", "cloud-nodes.com", "*.taobao.com = server:", "192.0.2.1 = server:"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("unexpected resolver bypass %q", forbidden)
		}
	}
	if strings.Index(out, "PROTOCOL,DOH,") > strings.Index(out, "RULE-SET,https://") {
		t.Fatal("DoH routing must precede business rule sets")
	}
}

func TestShadowrocket_DNSPrimaryAndBackupUseProxy(t *testing.T) {
	out := (&ShadowRocketRenderer{}).Render(Intermediate{}, "x", "")
	for _, want := range []string{
		"dns-server = " + primaryDoH + "#proxy," + backupDoH + "#proxy\n",
		"fallback-dns-server = " + backupDoH + "#proxy," + primaryDoH + "#proxy\n",
		"proxy-dns-server = " + bootstrapDoH + "\n",
		"dns-direct-system = false\n", "dns-direct-fallback-proxy = false\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, forbidden := range []string{"encrypted-dns-", "PROTOCOL,DOH", "Shepherd-DNS", "fallback-dns-server = 223", "doh.pub", "dns.alidns.com"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("unexpected DNS setting %q", forbidden)
		}
	}
}

func TestClash_DNSSeparatesBusinessAndBootstrap(t *testing.T) {
	im := Intermediate{Nodes: []Node{{Name: "n", Protocol: "trojan", Server: "proxy.example", Port: 443, Password: "p"}}}
	out := (&ClashRenderer{}).Render(im, "", "")
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatal(err)
	}
	dns := doc["dns"].(map[string]any)
	for _, server := range dns["nameserver"].([]any) {
		if !strings.HasSuffix(server.(string), "#Shepherd-DNS") {
			t.Fatalf("business resolver is not explicitly proxied: %v", server)
		}
	}
	if dns["proxy-server-nameserver"].([]any)[0] != bootstrapDoH {
		t.Fatal("node bootstrap must be explicit and independent")
	}
	if _, exists := dns["nameserver-policy"]; exists {
		t.Fatal("template must not retain owner-specific DNS policy")
	}
	found := false
	for _, value := range doc["proxy-groups"].([]any) {
		group := value.(map[string]any)
		if group["name"] == "Shepherd-DNS" {
			members := group["proxies"].([]any)
			if len(members) != 1 || members[0] != "n" {
				t.Fatalf("DNS group must not include DIRECT: %v", members)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("missing DNS group")
	}
}

func TestClash_DNSPolicySurvivesOverridesOrRejects(t *testing.T) {
	for _, extra := range []string{
		"proxy-groups: []",
		"proxy-groups:\n  - {name: Shepherd-DNS, type: select, proxies: [DIRECT]}",
		"proxy-groups:\n  - {name: Shepherd-DNS, type: select, proxies: [Other]}\n  - {name: Other, type: select, proxies: [DIRECT]}",
		"proxy-groups:\n  - {name: Shepherd-DNS, type: select, proxies: [Shepherd-DNS]}",
		"proxies:\n  - {name: Local, type: direct}\nproxy-groups:\n  - {name: Shepherd-DNS, type: select, proxies: [Local]}",
	} {
		out := (&ClashRenderer{}).Render(Intermediate{ClashGeneral: extra}, "", "")
		if !strings.HasPrefix(out, "# Clash render error:") {
			t.Errorf("unsafe implicit DNS policy override accepted: %s", extra)
		}
	}
	// Administrators may explicitly replace the DNS URLs and group taxonomy.
	out := (&ClashRenderer{}).Render(Intermediate{ClashGeneral: "proxy-groups: []\ndns:\n  nameserver: [https://resolver.example/dns-query]\nrules: [MATCH,REJECT]"}, "", "")
	// rules must be an array of complete strings, not YAML comma-separated fields.
	if !strings.HasPrefix(out, "# Clash render error:") {
		t.Fatal("invalid rules must not bypass final validation")
	}
	out = (&ClashRenderer{}).Render(Intermediate{ClashGeneral: "proxy-groups: []\ndns:\n  nameserver: [https://resolver.example/dns-query]\nrules: ['MATCH,REJECT']"}, "", "")
	if strings.HasPrefix(out, "# Clash render error:") {
		t.Fatal("explicit resolver override should remain available")
	}
}

func TestDNSPolicyNameAvoidsUserCollisions(t *testing.T) {
	im := Intermediate{Nodes: []Node{{Name: "Shepherd-DNS"}}, Groups: []Group{{Name: "Shepherd-DNS-DNS"}}}
	if got := dnsPolicyName(im); got != "Shepherd-DNS-DNS-DNS" {
		t.Fatalf("name = %q", got)
	}
}

func TestSurgeBootstrapHostsUsesSSHEntryAndDeduplicates(t *testing.T) {
	nodes := []Node{
		{Server: "edge.example"}, {Server: "EDGE.example"}, {Server: "[2001:db8::1]"},
		{Server: "inside.example", SSH: &SSHForward{Host: "jump.example"}},
		{Server: "*.business.example"}, {Server: "localhost"},
	}
	if got := surgeBootstrapHosts(nodes); got != "edge.example = server:223.5.5.5\njump.example = server:223.5.5.5" {
		t.Fatalf("bootstrap = %q", got)
	}
}

func TestSurgeFamily_GeneralOverridesOnceAfterTargetDefaults(t *testing.T) {
	for _, target := range []string{"surge", "shadowrocket"} {
		r, _ := rendererFor(target)
		im := Intermediate{General: "ipv6 = true\nhijack-dns = 9.9.9.9:53\ndns-server = https://resolver.example/dns-query\nnew-option = yes"}
		out := r.Render(im, "x", "")
		general := strings.Split(strings.Split(out, "[General]\n")[1], "[Proxy]")[0]
		for _, key := range []string{"ipv6", "hijack-dns", "dns-server", "new-option"} {
			if n := strings.Count("\n"+general, "\n"+key+" = "); n != 1 {
				t.Errorf("%s key %s occurs %d times", target, key, n)
			}
		}
		if !strings.Contains(general, "ipv6 = true\n") || !strings.Contains(general, "dns-server = https://resolver.example/dns-query\n") {
			t.Errorf("%s override was overwritten", target)
		}
	}
}

func TestGeneralRejectsDuplicateKeysAndSectionInjection(t *testing.T) {
	for _, extra := range []string{"ipv6 = true\nIPV6 = false", "[Rule]\nFINAL,DIRECT", "not-a-key"} {
		if _, _, err := parseGeneral(extra); err == nil {
			t.Errorf("accepted %q", extra)
		}
	}
}

func TestSurgeFamily_UnsupportedUDPRejects(t *testing.T) {
	for _, target := range []string{"surge", "shadowrocket"} {
		t.Run(target, func(t *testing.T) {
			r, _ := rendererFor(target)
			out := r.Render(Intermediate{}, "https://example.com/sub/test", DefaultRulesetBase)
			if !strings.Contains(out, "udp-policy-not-supported-behaviour = REJECT\n") {
				t.Fatal("unsupported UDP must be rejected instead of sent directly")
			}
			if strings.Contains(out, "udp-policy-not-supported-behaviour = DIRECT") {
				t.Fatal("unsupported UDP may expose the local public address")
			}
		})
	}
}
