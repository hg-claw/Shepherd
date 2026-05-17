package cloudflare

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "cloudflare",
		Name:        "Cloudflare",
		Description: "Manage Cloudflare zones, DNS records, and view recent audit log.",
		Icon:        "cloud",
		Category:    "dns",
		HostAware:   false,
	}
}
