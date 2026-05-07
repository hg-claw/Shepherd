package config

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/hg-claw/Shepherd/internal/db"
)

const (
	DistributionEmbedded = "embedded"
	DistributionGitHub   = "github"
)

type Config struct {
	HTTPAddr             string
	ServerPublicURL      string // optional; if set, used as the URL agents dial back to
	DBDriver             db.Driver
	DBDSN                string
	AutoRecoverKey       string
	InitialAdminUsername string
	InitialAdminPassword string
	AgentDistribution    string // embedded | github
	AgentDownloadTag     string // overrides BuildVersion when AgentDistribution=github
	BuildVersion         string // injected via -ldflags at release time, defaults to "dev"
	CookieSecure         bool   // set true behind TLS reverse proxy
}

func FromEnv() (Config, error) {
	c := Config{
		HTTPAddr:             getEnvDefault("SERVER_HTTP_ADDR", ":8080"),
		ServerPublicURL:      os.Getenv("SERVER_PUBLIC_URL"),
		DBDriver:             db.Driver(getEnvDefault("DATABASE_DRIVER", "sqlite")),
		DBDSN:                os.Getenv("DATABASE_DSN"),
		AutoRecoverKey:       os.Getenv("AUTO_RECOVER_KEY"),
		InitialAdminUsername: os.Getenv("INITIAL_ADMIN_USERNAME"),
		InitialAdminPassword: os.Getenv("INITIAL_ADMIN_PASSWORD"),
		AgentDistribution:    strings.ToLower(getEnvDefault("AGENT_DISTRIBUTION", DistributionEmbedded)),
		AgentDownloadTag:     os.Getenv("AGENT_DOWNLOAD_TAG"),
		BuildVersion:         BuildVersion,
		CookieSecure:         getEnvDefault("COOKIE_SECURE", "false") == "true",
	}
	if c.DBDSN == "" {
		if c.DBDriver == db.DriverSQLite {
			c.DBDSN = "file:./shepherd.db?_fk=1"
		} else {
			return c, errors.New("DATABASE_DSN required when DATABASE_DRIVER=postgres")
		}
	}
	switch c.DBDriver {
	case db.DriverSQLite, db.DriverPostgres:
	default:
		return c, fmt.Errorf("DATABASE_DRIVER %q invalid", c.DBDriver)
	}
	switch c.AgentDistribution {
	case DistributionEmbedded, DistributionGitHub:
	default:
		return c, fmt.Errorf("AGENT_DISTRIBUTION %q invalid", c.AgentDistribution)
	}
	return c, nil
}

// BuildVersion is overridden at link time:
//
//	go build -ldflags "-X github.com/hg-claw/Shepherd/internal/config.BuildVersion=v0.1.0" ...
var BuildVersion = "dev"

func getEnvDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
