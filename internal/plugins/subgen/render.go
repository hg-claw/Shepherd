package subgen

import "strings"

type Renderer interface {
	Target() string
	Supports(protocol string) bool
	Render(im Intermediate, subURL, rulesetBase string) string
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
