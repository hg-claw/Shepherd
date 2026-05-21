package plugins

import (
	"context"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestRegisterAndGet(t *testing.T) {
	resetRegistryForTest()
	p := fakePlain{}
	Register(p)
	got, ok := Get("p")
	if !ok || got != Plugin(p) {
		t.Fatalf("Get(p) = %v, %v", got, ok)
	}
}

func TestRegisterDuplicatePanics(t *testing.T) {
	resetRegistryForTest()
	Register(fakePlain{})
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic on duplicate register")
		}
	}()
	Register(fakePlain{})
}

func TestAllReturnsStableOrder(t *testing.T) {
	resetRegistryForTest()
	Register(namedFake{id: "b"})
	Register(namedFake{id: "a"})
	Register(namedFake{id: "c"})
	got := []string{}
	for _, p := range All() {
		got = append(got, p.Meta().ID)
	}
	want := []string{"a", "b", "c"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("All order = %v want %v", got, want)
		}
	}
}

type namedFake struct{ id string }

func (n namedFake) Meta() Meta                                       { return Meta{ID: n.id} }
func (namedFake) Migrations(_ shepdb.Driver) []Migration             { return nil }
func (namedFake) RegisterRoutes(_ Mux, _ Deps)                       {}
func (namedFake) OnEnable(_ context.Context, _ Deps) error           { return nil }
func (namedFake) OnDisable(_ context.Context, _ Deps) error          { return nil }
