package cloudflare

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func TestMetaNotHostAware(t *testing.T) {
	m := New().Meta()
	if m.HostAware {
		t.Fatal("cloudflare must not be host-aware")
	}
	if m.ID != "cloudflare" {
		t.Fatalf("id = %s", m.ID)
	}
}

func TestSatisfiesPlugin(t *testing.T) {
	var _ plugins.Plugin = New()
}
