package xray

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "xray",
		Name:        "xray",
		Description: "Manage xray-core as a proxy on selected hosts.",
		Icon:        "shield",
		Category:    "proxy",
		HostAware:   true,
	}
}
