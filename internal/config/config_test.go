package config

import (
	"testing"
)

func TestFromEnv_DefaultsSQLite(t *testing.T) {
	t.Setenv("SERVER_HTTP_ADDR", "")
	t.Setenv("DATABASE_DRIVER", "")
	t.Setenv("DATABASE_DSN", "")
	t.Setenv("AGENT_DISTRIBUTION", "")
	c, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.HTTPAddr != ":8080" {
		t.Errorf("HTTPAddr=%q want :8080", c.HTTPAddr)
	}
	if string(c.DBDriver) != "sqlite" {
		t.Errorf("DBDriver=%q want sqlite", c.DBDriver)
	}
	if c.DBDSN == "" {
		t.Error("DBDSN should default for sqlite")
	}
	if c.AgentDistribution != "embedded" {
		t.Errorf("AgentDistribution=%q want embedded", c.AgentDistribution)
	}
}

func TestFromEnv_PostgresRequiresDSN(t *testing.T) {
	t.Setenv("DATABASE_DRIVER", "postgres")
	t.Setenv("DATABASE_DSN", "")
	if _, err := FromEnv(); err == nil {
		t.Fatal("want error")
	}
}

func TestFromEnv_RejectsBadDistribution(t *testing.T) {
	t.Setenv("AGENT_DISTRIBUTION", "carrierpigeon")
	if _, err := FromEnv(); err == nil {
		t.Fatal("want error")
	}
}
