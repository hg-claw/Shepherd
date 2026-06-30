package subgen

import "strings"

type Renderer interface {
	Target() string
	Supports(protocol string) bool
	Render(im Intermediate, subURL, rulesetBase string) string
}

// nodesToken, used as a member of a custom proxy group, expands to all selected
// node names — so a group can include every selected proxy without listing them
// by hand. It mirrors the {{NODES}} template placeholder, made usable inside the
// custom-groups field (where the placeholder substitution doesn't otherwise reach).
const nodesToken = "{{NODES}}"

// expandGroupNodes replaces a member equal to nodesToken with the full list of
// selected node names; every other member passes through unchanged. Each format
// renderer then quotes/joins the result as it normally would.
func expandGroupNodes(members, nodeNames []string) []string {
	out := make([]string, 0, len(members))
	for _, m := range members {
		if strings.TrimSpace(m) == nodesToken {
			out = append(out, nodeNames...)
			continue
		}
		out = append(out, m)
	}
	return out
}

// dropDevicePolicies removes Surge-only DEVICE: members (Surge Ponte). Clash and
// ShadowRocket have no Ponte equivalent, so those renderers filter them out.
func dropDevicePolicies(members []string) []string {
	out := make([]string, 0, len(members))
	for _, m := range members {
		if !strings.HasPrefix(m, "DEVICE:") {
			out = append(out, m)
		}
	}
	return out
}

func rendererFor(target string) (Renderer, bool) {
	switch target {
	case "surge":
		return &SurgeRenderer{}, true
	case "shadowrocket":
		return &ShadowRocketRenderer{}, true
	case "clash":
		return &ClashRenderer{}, true
	default:
		return nil, false
	}
}
