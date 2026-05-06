package agentconfig

import (
	"errors"
	"os"
	"strings"
)

type Config struct {
	ServerURL       string
	EnrollmentToken string
	AutoRecoverKey  string
	AgentVersion    string
	StatePath       string
}

var BuildVersion = "dev" // overridden at link time

func FromEnv() (Config, error) {
	c := Config{
		ServerURL:       strings.TrimRight(os.Getenv("SERVER_URL"), "/"),
		EnrollmentToken: os.Getenv("ENROLLMENT_TOKEN"),
		AutoRecoverKey:  os.Getenv("AUTO_RECOVER_KEY"),
		AgentVersion:    BuildVersion,
		StatePath:       os.Getenv("STATE_PATH"),
	}
	if c.ServerURL == "" {
		return c, errors.New("SERVER_URL required")
	}
	return c, nil
}

// WSURL converts a server URL into the WebSocket URL for /agent/ws.
func (c Config) WSURL() string {
	switch {
	case strings.HasPrefix(c.ServerURL, "https://"):
		return "wss://" + strings.TrimPrefix(c.ServerURL, "https://") + "/agent/ws"
	case strings.HasPrefix(c.ServerURL, "http://"):
		return "ws://" + strings.TrimPrefix(c.ServerURL, "http://") + "/agent/ws"
	}
	return "ws://" + c.ServerURL + "/agent/ws"
}
