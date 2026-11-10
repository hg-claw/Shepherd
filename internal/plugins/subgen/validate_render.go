package subgen

import (
	"fmt"
	"strings"
)

var renderMarkers = []string{
	"{{PROXIES}}", "{{WIREGUARD}}", "{{NODES}}", "{{CUSTOM_RULES}}",
	"{{CUSTOM_GROUPS}}", "{{GENERAL_EXTRA}}", "{{CLASH_EXTRA}}",
	"{{CUSTOM_PROVIDERS}}", "{{URLREWRITE_EXTRA}}", "{{MITM}}",
	"{{DNS_RULES}}", "{{DOMESTIC_DNS_HOSTS}}", "{{DOMESTIC_DNS_POLICY}}", "{{BOOTSTRAP_HOSTS}}",
}

func safeRenderValue(s string) bool {
	if !safeRuleText(s) {
		return false
	}
	for _, marker := range renderMarkers {
		if strings.Contains(s, marker) {
			return false
		}
	}
	return true
}

func safeExtraValue(value any) bool {
	switch v := value.(type) {
	case string:
		return safeRenderValue(v)
	case []string:
		for _, item := range v {
			if !safeRenderValue(item) {
				return false
			}
		}
	case []any:
		for _, item := range v {
			if !safeExtraValue(item) {
				return false
			}
		}
	case map[string]any:
		for key, item := range v {
			if !safeRenderValue(key) || !safeExtraValue(item) {
				return false
			}
		}
	}
	return true
}

// Interpolated single-line values must not introduce a new section/rule or be
// reinterpreted as a later template marker. Raw administrator section overrides
// are intentionally separate and disable automatic domestic DNS exceptions.
func validateRenderValues(im Intermediate) error {
	if !validDNSMode(im.DNSMode) {
		return fmt.Errorf("unknown DNS mode")
	}
	for _, node := range im.Nodes {
		for _, value := range []string{node.Name, node.Protocol, node.Server, node.UUID, node.Password,
			node.SNI, node.Flow, node.RealityPublicKey, node.RealityShortID, node.Transport,
			node.Path, node.Host, node.SSMethod} {
			if !safeRenderValue(value) {
				return fmt.Errorf("node contains a control character or reserved template marker")
			}
		}
		if !safeExtraValue(node.Extra) || !safeExtraValue(node.ALPN) {
			return fmt.Errorf("node options contain a control character or reserved template marker")
		}
		if node.SSH != nil {
			for _, value := range []string{node.SSH.Host, node.SSH.Username, node.SSH.PrivateKey} {
				if !safeRenderValue(value) {
					return fmt.Errorf("SSH forwarding contains an unsafe multiline value")
				}
			}
		}
	}
	for _, rule := range im.Rules {
		for _, value := range []string{rule.Match, rule.Native, rule.Ruleset, rule.Target} {
			if !safeRenderValue(value) {
				return fmt.Errorf("custom rule contains a control character or reserved template marker")
			}
		}
	}
	for _, group := range im.Groups {
		if !safeRenderValue(group.Name) || !safeRenderValue(group.Type) {
			return fmt.Errorf("custom group contains an unsafe value")
		}
		for _, member := range group.Members {
			if member != nodesToken && !safeRenderValue(member) {
				return fmt.Errorf("custom group member contains an unsafe value")
			}
		}
	}
	return nil
}
