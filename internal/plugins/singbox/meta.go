package singbox

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "singbox",
		Name:        "sing-box",
		Description: "Manage sing-box as a proxy on selected hosts (18-protocol catalog + ACME certs).",
		Icon:        "box",
		Category:    "proxy",
		HostAware:   true,
	}
}
