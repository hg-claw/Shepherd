package agentapi

import (
	"regexp"
	"testing"
)

func TestNewSID(t *testing.T) {
	pat := regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		s := NewSID()
		if !pat.MatchString(s) {
			t.Fatalf("sid %q does not match pattern", s)
		}
		if seen[s] {
			t.Fatalf("duplicate sid %q at iter %d", s, i)
		}
		seen[s] = true
	}
}

func TestValidSID(t *testing.T) {
	if !ValidSID(NewSID()) {
		t.Fatal("generated sid not accepted by ValidSID")
	}
	if ValidSID("with/slash/here/and/way/too/long") {
		t.Fatal("invalid sid accepted")
	}
	if ValidSID("") {
		t.Fatal("empty sid accepted")
	}
}
