package state

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

const DefaultPath = "/etc/shepherd/agent.state.json"

type State struct {
	MachineToken             string `json:"machine_token"`
	Fingerprint              string `json:"fingerprint"`
	TelemetryIntervalSeconds int    `json:"telemetry_interval_seconds"`
}

type Store struct {
	Path string
	mu   sync.Mutex
}

func (s *Store) path() string {
	if s.Path == "" {
		return DefaultPath
	}
	return s.Path
}

func (s *Store) Load() (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.path())
	if errors.Is(err, os.ErrNotExist) {
		return &State{}, nil
	}
	if err != nil {
		return nil, err
	}
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, err
	}
	return &st, nil
}

func (s *Store) Save(st *State) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.path()), 0o750); err != nil {
		return err
	}
	tmp := s.path() + ".tmp"
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path())
}
