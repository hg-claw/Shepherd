package sshaudit

import "github.com/hg-claw/Shepherd/internal/plugins"

func meta() plugins.Meta {
	return plugins.Meta{
		ID:          "sshaudit",
		Name:        "SSH Audit",
		Description: "Active SSH sessions and login success/failure history per host.",
		Icon:        "shield",
		Category:    "security",
		HostAware:   false,
	}
}
