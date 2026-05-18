package plugins

import (
	"fmt"
	"sort"
	"sync"
)

var (
	regMu sync.Mutex
	reg   = map[string]Plugin{}
)

// Register adds a plugin to the global registry. Called from each plugin's
// init(). Panics on duplicate ID — the call sites are all compile-time
// imports, so a duplicate is a programmer error caught at boot.
func Register(p Plugin) {
	regMu.Lock()
	defer regMu.Unlock()
	id := p.Meta().ID
	if id == "" {
		panic("plugins: empty Meta.ID")
	}
	if _, dup := reg[id]; dup {
		panic(fmt.Sprintf("plugins: duplicate registration for %q", id))
	}
	reg[id] = p
}

// Get returns a plugin by ID.
func Get(id string) (Plugin, bool) {
	regMu.Lock()
	defer regMu.Unlock()
	p, ok := reg[id]
	return p, ok
}

// All returns every registered plugin sorted by ID, so the manifest is
// deterministic across boots.
func All() []Plugin {
	regMu.Lock()
	defer regMu.Unlock()
	out := make([]Plugin, 0, len(reg))
	for _, p := range reg {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Meta().ID < out[j].Meta().ID })
	return out
}

// resetRegistryForTest clears the registry. Test-only.
func resetRegistryForTest() {
	regMu.Lock()
	defer regMu.Unlock()
	reg = map[string]Plugin{}
}
