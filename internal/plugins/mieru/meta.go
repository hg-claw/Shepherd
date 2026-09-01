package mieru

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "mieru",
		Name:        "mieru",
		Description: "Manage official mita (mieru server) on selected hosts.",
		Icon:        "radio",
		Category:    "proxy",
		HostAware:   true,
	}
}
