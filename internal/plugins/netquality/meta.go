package netquality

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "netquality",
		Name:        "Network Quality",
		Description: "Periodic ping probes from each server to China-Telecom / Unicom / Mobile and overseas targets, with history and rollups.",
		Icon:        "activity",
		Category:    "network",
		HostAware:   true,
	}
}
