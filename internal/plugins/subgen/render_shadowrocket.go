package subgen

// placeholder — full impl (Task 11). Embeds SurgeRenderer so it satisfies Renderer.
type ShadowRocketRenderer struct{ SurgeRenderer }

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }
