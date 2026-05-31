package subgen

import "testing"

func TestOixServiceGroupMembership(t *testing.T) {
	if !isOixServiceGroup("Netflix") {
		t.Errorf("Netflix should be a service group")
	}
	if isOixServiceGroup("Proxy") {
		t.Errorf("Proxy is core, not a selectable service group")
	}
	if isOixServiceGroup("Nope") {
		t.Errorf("unknown name must not be a service group")
	}
}

func TestNormalizeServiceGroups(t *testing.T) {
	got := normalizeServiceGroups([]string{"Netflix", "Proxy", "Bogus", "AdBlock"})
	want := []string{"Netflix", "AdBlock"} // core + unknown dropped, order preserved
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("got %v want %v", got, want)
	}
}

func TestDisabledServiceSet(t *testing.T) {
	s := disabledServiceSet([]string{"Netflix", "Proxy"})
	if !s["Netflix"] || s["Proxy"] {
		t.Fatalf("got %v", s)
	}
}
