package subgen

// ShadowRocket consumes the Surge .conf syntax, with two differences: WireGuard
// is an inline [Proxy] line (no [WireGuard] section), and Surge-only DEVICE:
// (Ponte) members/rules are filtered out. It embeds SurgeRenderer and overrides
// only Target() and Render() (passing target="shadowrocket", which selects both).
type ShadowRocketRenderer struct{ SurgeRenderer }

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }

func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "shadowrocket")
}
