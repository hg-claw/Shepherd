package singbox_test

import (
	"testing"

	"github.com/hg-claw/Shepherd/internal/plugins"
	_ "github.com/hg-claw/Shepherd/internal/plugins/singbox"
)

func TestSingboxRegistered(t *testing.T) {
	all := plugins.All()
	for _, p := range all {
		if p.Meta().ID == "singbox" {
			return
		}
	}
	t.Fatalf("singbox not found in plugins.All(); registered: %v", func() []string {
		ids := make([]string, len(all))
		for i, p := range all { ids[i] = p.Meta().ID }
		return ids
	}())
}
