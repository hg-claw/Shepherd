package subgen

// ShadowRocket consumes the same Surge .conf syntax, so all behaviour is
// inherited from SurgeRenderer; only Target() differs.  Override individual
// methods here only when a real divergence from Surge is discovered.
type ShadowRocketRenderer struct{ SurgeRenderer }

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }
