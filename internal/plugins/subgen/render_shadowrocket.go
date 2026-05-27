package subgen

// ShadowRocket consumes the Surge .conf syntax, except WireGuard, which it takes
// as an inline [Proxy] line (no [WireGuard] section). It inherits everything from
// SurgeRenderer and overrides only Target() and Render() (the latter to render
// WireGuard inline via wgInline=true).
type ShadowRocketRenderer struct{ SurgeRenderer }

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }

func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, true)
}
