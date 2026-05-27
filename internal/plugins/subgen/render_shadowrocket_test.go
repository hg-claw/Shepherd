package subgen

import (
	"strings"
	"testing"
)

func TestShadowRocket_RendersAndReportsTarget(t *testing.T) {
	r := &ShadowRocketRenderer{}
	if r.Target() != "shadowrocket" {
		t.Fatalf("target=%s", r.Target())
	}
	im := Intermediate{
		Nodes:  []Node{{Name: "tu1", Protocol: "tuic", Server: "1.1.1.1", Port: 443, Password: "p", UUID: "u", SNI: "s"}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"tu1"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := r.Render(im, "https://x/sub/t?target=shadowrocket", DefaultRulesetBase)
	for _, want := range []string{
		"[Proxy]", "tu1 = tuic, 1.1.1.1, 443, password=p, uuid=u, sni=s",
		"[Proxy Group]", "PROXY = select, tu1, DIRECT", "[Rule]", "FINAL,PROXY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q\n%s", want, out)
		}
	}
}
