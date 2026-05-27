package subgen

type Renderer interface {
	Target() string
	Supports(protocol string) bool
	Render(im Intermediate, subURL, rulesetBase string) string
}

func rendererFor(target string) (Renderer, bool) {
	switch target {
	case "surge":
		return &SurgeRenderer{}, true
	case "shadowrocket":
		return &ShadowRocketRenderer{}, true
	default:
		return nil, false
	}
}
