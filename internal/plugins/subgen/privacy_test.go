package subgen

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestSurge_DefaultDNSIsPrivateWithReviewedDomesticExceptions(t *testing.T) {
	im := Intermediate{Nodes: []Node{
		{Name: "domain-node", Protocol: "trojan", Server: "edge.example", Port: 443, Password: "p", SNI: "edge.example"},
		{Name: "ip-node", Protocol: "trojan", Server: "192.0.2.1", Port: 443, Password: "p", SNI: "edge.example"},
	}}
	out := (&SurgeRenderer{}).Render(im, "https://example.com/sub/test", "")
	for _, want := range []string{
		"encrypted-dns-server = " + primaryDoH + ", " + backupDoH,
		"encrypted-dns-follow-outbound-mode = true",
		"IP-CIDR,223.5.5.5/32,DIRECT,no-resolve\nPROTOCOL,DOH,Proxy\n",
		"taobao.com = server:" + domesticDoH + "\n",
		"*.taobao.com = server:" + domesticDoH + "\n",
		"use-local-host-item-for-proxy = false",
		"Proxy = select, Auto - Smart, Auto - UrlTest, Direct, domain-node, ip-node\n",
		"edge.example = server:223.5.5.5\n",
		"hijack-dns = *:53\n",
		"Domestic = select, Direct, Proxy",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, forbidden := range []string{"Shepherd-DNS", "dns-server = system", "cloud-nodes.com", "*.cn = server:", "example.net = server:", "192.0.2.1 = server:"} {
		if strings.Contains(out, forbidden) {
			t.Errorf("unexpected resolver bypass %q", forbidden)
		}
	}
}

func TestShadowrocket_DNSPrimaryAndBackupUseProxy(t *testing.T) {
	out := (&ShadowRocketRenderer{}).Render(Intermediate{}, "x", "")
	for _, want := range []string{
		"dns-server = " + primaryDoH + "#proxy," + backupDoH + "#proxy\n",
		"fallback-dns-server = " + backupDoH + "#proxy," + primaryDoH + "#proxy\n",
		"proxy-dns-server = " + bootstrapDoH + "\n",
		"use-local-host-item-for-proxy = false\n",
		"dns-direct-system = false\n", "dns-direct-fallback-proxy = false\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q", want)
		}
	}
	for _, forbidden := range []string{"encrypted-dns-", "PROTOCOL,DOH", "Shepherd-DNS", "direct-dns-server =", "server:" + domesticDoH, "fallback-dns-server = 223", "doh.pub", "dns.alidns.com"} {
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
		if !strings.HasSuffix(server.(string), "#Proxy") {
			t.Fatalf("business resolver does not follow Proxy: %v", server)
		}
	}
	if dns["proxy-server-nameserver"].([]any)[0] != bootstrapDoH {
		t.Fatal("node bootstrap must be explicit and independent")
	}
	if _, exists := dns["direct-nameserver"]; exists {
		t.Fatal("unknown DIRECT targets must not inherit a global domestic resolver")
	}
	policy := dns["nameserver-policy"].(map[string]any)
	if policy["+.taobao.com"].([]any)[0] != domesticDoH+"#DIRECT" {
		t.Fatal("reviewed domestic CDN policy missing")
	}
	for _, key := range []string{"+.cn", "+.qq.com", "example.net", "+.example.net", "+.cloud-nodes.com"} {
		if _, exists := policy[key]; exists {
			t.Errorf("unsafe or inherited DNS policy %s", key)
		}
	}
	found := false
	for _, value := range doc["proxy-groups"].([]any) {
		group := value.(map[string]any)
		if group["name"] == "Shepherd-DNS" {
			t.Fatal("independent DNS group must not be emitted")
		}
		if group["name"] == "Proxy" {
			members := group["proxies"].([]any)
			if len(members) != 3 || members[0] != "Auto - UrlTest" || members[1] != "DIRECT" || members[2] != "n" {
				t.Fatalf("business Proxy selection changed: %v", members)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("missing business Proxy group")
	}
}

func TestClash_DNSPolicySurvivesOverridesOrRejects(t *testing.T) {
	for _, extra := range []string{
		"proxy-groups: []",
		"proxy-groups:\n  - {name: Proxy, type: select, proxies: [Missing]}",
		"proxy-groups:\n  - {name: Proxy, type: select, proxies: [Other]}\n  - {name: Other, type: select, proxies: [Proxy]}",
		"proxy-groups:\n  - {name: Proxy, type: select, proxies: [Proxy]}",
		"proxies:\n  - {name: Proxy, type: direct}\nproxy-groups:\n  - {name: Proxy, type: select, proxies: [DIRECT]}",
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

func TestClash_DNSAllowsExplicitProxyDirectSelection(t *testing.T) {
	for _, extra := range []string{
		"proxy-groups:\n  - {name: Proxy, type: select, proxies: [DIRECT]}",
		"proxy-groups:\n  - {name: Proxy, type: select, proxies: [Other]}\n  - {name: Other, type: select, proxies: [DIRECT]}",
		"proxies:\n  - {name: Local, type: direct}\nproxy-groups:\n  - {name: Proxy, type: select, proxies: [Local]}",
	} {
		out := (&ClashRenderer{}).Render(Intermediate{ClashGeneral: extra + "\nrules: ['MATCH,Proxy']"}, "", "")
		if strings.HasPrefix(out, "# Clash render error:") {
			t.Fatalf("explicit Proxy direct selection rejected:\n%s", out)
		}
		var doc map[string]any
		if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
			t.Fatal(err)
		}
		dns := doc["dns"].(map[string]any)
		if dns["nameserver"].([]any)[0] != primaryDoH+"#Proxy" {
			t.Fatal("resolver stopped following Proxy")
		}
	}
}

func TestClash_EmptyNodesKeepProxyDNSReferenceValid(t *testing.T) {
	out := (&ClashRenderer{}).Render(Intermediate{}, "", "")
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatal(err)
	}
	for _, value := range doc["proxy-groups"].([]any) {
		group := value.(map[string]any)
		if group["name"] == "Auto - UrlTest" {
			members := group["proxies"].([]any)
			if len(members) != 1 || members[0] != "REJECT" {
				t.Fatalf("empty auto group should reject: %v", members)
			}
			return
		}
	}
	t.Fatal("missing auto group referenced by Proxy")
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

func TestAdaptiveDNSOverridesRemainExplicit(t *testing.T) {
	out := (&SurgeRenderer{}).Render(Intermediate{General: "encrypted-dns-server = https://resolver.example/dns-query\nencrypted-dns-follow-outbound-mode = true"}, "x", "")
	if strings.Count(out, "\nencrypted-dns-server = ") != 1 || !strings.Contains(out, "encrypted-dns-server = https://resolver.example/dns-query\n") {
		t.Fatal("Surge explicit DNS override lost or duplicated")
	}
	out = (&ShadowRocketRenderer{}).Render(Intermediate{General: "direct-dns-server = https://resolver.example/dns-query"}, "x", "")
	if strings.Count(out, "\ndirect-dns-server = ") != 1 || !strings.Contains(out, "direct-dns-server = https://resolver.example/dns-query\n") {
		t.Fatal("SR explicit direct DNS override lost or duplicated")
	}
	out = (&ClashRenderer{}).Render(Intermediate{ClashGeneral: "dns:\n  listen: 127.0.0.1:5353"}, "", "")
	doc := decodeRenderedClash(t, out)
	dns := doc["dns"].(map[string]any)
	if dns["nameserver-policy"].(map[string]any)["+.taobao.com"].([]any)[0] != domesticDoH+"#DIRECT" || dns["nameserver"].([]any)[0] != primaryDoH+"#Proxy" {
		t.Fatal("unrelated override removed private DNS defaults or reviewed exceptions")
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
