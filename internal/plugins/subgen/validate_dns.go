package subgen

import (
	"fmt"
	"strings"
)

// validateClashDNSPolicy prevents an unrelated proxy-groups override from
// removing the policy still referenced by the default DNS URLs. DNS deliberately
// follows the user's Proxy selection, including DIRECT; this validates references
// and cycles, not a proxy-only membership constraint. Mihomo treats an unknown
// #name as an interface, not a missing proxy error. Explicit replacement of the
// DNS URLs remains an administrator override.
func validateClashDNSPolicy(conf, policy string) error {
	doc, err := decodeClashMapping(conf, false)
	if err != nil {
		return err
	}
	dns, _ := doc["dns"].(map[string]any)
	usesPolicy := false
	for _, key := range []string{"nameserver", "fallback", "direct-nameserver", "proxy-server-nameserver"} {
		servers, _ := dns[key].([]any)
		for _, server := range servers {
			if text, ok := server.(string); ok && strings.HasSuffix(text, "#"+policy) {
				usesPolicy = true
			}
		}
	}
	if !usesPolicy {
		return nil
	}
	entries := make(map[string]map[string]any)
	duplicates := make(map[string]bool)
	for _, key := range []string{"proxies", "proxy-groups"} {
		values, _ := doc[key].([]any)
		for _, value := range values {
			entry, _ := value.(map[string]any)
			name, _ := entry["name"].(string)
			if _, exists := entries[name]; exists {
				duplicates[name] = true
			}
			entries[name] = entry
		}
	}
	var visit func(string, map[string]bool) error
	visit = func(name string, stack map[string]bool) error {
		switch name {
		case "DIRECT", "REJECT", "REJECT-DROP":
			return nil
		case "COMPATIBLE", "PASS", "GLOBAL":
			return fmt.Errorf("DNS policy %q must not reach %s", policy, name)
		}
		entry, exists := entries[name]
		if !exists || duplicates[name] {
			return fmt.Errorf("DNS policy %q references missing or ambiguous member %q", policy, name)
		}
		if stack[name] {
			return fmt.Errorf("DNS policy %q contains a cycle at %q", policy, name)
		}
		kind, _ := entry["type"].(string)
		switch strings.ToLower(kind) {
		case "direct", "reject":
			return nil
		case "pass", "compatible":
			return fmt.Errorf("DNS policy %q contains a pass/compatible adapter", policy)
		}
		if providers, ok := entry["use"].([]any); ok && len(providers) > 0 {
			return fmt.Errorf("DNS policy %q cannot verify dynamic provider members", policy)
		}
		if members, ok := entry["proxies"].([]any); ok {
			if len(members) == 0 {
				return fmt.Errorf("DNS policy %q contains an empty group", policy)
			}
			stack[name] = true
			defer delete(stack, name)
			for _, member := range members {
				child, ok := member.(string)
				if !ok {
					return fmt.Errorf("DNS policy %q has a non-string member", policy)
				}
				if err := visit(child, stack); err != nil {
					return err
				}
			}
			return nil
		}
		if server, _ := entry["server"].(string); server == "" {
			return fmt.Errorf("DNS policy %q contains a member without a proxy server", policy)
		}
		return nil
	}
	return visit(policy, make(map[string]bool))
}
