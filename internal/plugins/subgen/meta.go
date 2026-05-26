package subgen

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "subgen",
		Name:        "Subscriptions",
		Description: "Aggregate managed xray/sing-box inbounds into client subscription URLs (Surge, ShadowRocket) with category routing.",
		Icon:        "rss",
		Category:    "proxy",
		HostAware:   false,
	}
}
