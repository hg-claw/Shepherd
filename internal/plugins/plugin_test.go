package plugins

import (
	"context"
	"testing"
)

func TestMetaIsValueType(t *testing.T) {
	m := Meta{ID: "x", Name: "X", HostAware: true}
	clone := m
	clone.ID = "y"
	if m.ID != "x" {
		t.Fatal("Meta should be a value type")
	}
}

func TestHostStatusZeroValueState(t *testing.T) {
	var s HostStatus
	if s.State != "" {
		t.Fatal("zero HostStatus.State must be empty string for callers to distinguish unknown")
	}
}

// fakePlain is a minimal Plugin implementation for compile-time interface verification.
type fakePlain struct{}

func (fakePlain) Meta() Meta                                       { return Meta{ID: "p"} }
func (fakePlain) Migrations() []Migration                          { return nil }
func (fakePlain) RegisterRoutes(_ Mux, _ Deps)                     {}
func (fakePlain) OnEnable(_ context.Context, _ Deps) error         { return nil }
func (fakePlain) OnDisable(_ context.Context, _ Deps) error        { return nil }

func TestFakeImplementsPlugin(t *testing.T) {
	var _ Plugin = fakePlain{}
}
