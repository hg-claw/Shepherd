package xray

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestXrayMetaIsHostAware(t *testing.T) {
	p := New()
	m := p.Meta()
	if m.ID != "xray" {
		t.Fatalf("id = %s", m.ID)
	}
	if !m.HostAware {
		t.Fatal("meta.HostAware must be true")
	}
}

func TestXraySatisfiesHostAware(t *testing.T) {
	var _ plugins.HostAware = New()
}

func TestXrayMigrationsHaveContent(t *testing.T) {
	p := New()
	migs := p.Migrations()
	if len(migs) == 0 {
		t.Fatal("expected at least one migration")
	}
	if migs[0].Name == "" || migs[0].SQL == "" {
		t.Fatalf("empty migration: %+v", migs[0])
	}
}
