package subgen

import (
	"context"
	"testing"
)

func TestTemplateValidate(t *testing.T) {
	good := `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`
	if _, err := ParseTemplate(good); err != nil {
		t.Fatalf("good template rejected: %v", err)
	}
	badCat := `{"categories":[{"name":"Nope","policy":"PROXY"}],"final":"PROXY"}`
	if _, err := ParseTemplate(badCat); err == nil {
		t.Fatal("unknown category accepted")
	}
	badPolicy := `{"categories":[{"name":"Telegram","policy":""}],"final":"PROXY"}`
	if _, err := ParseTemplate(badPolicy); err == nil {
		t.Fatal("empty policy accepted")
	}
}

func TestSeedBuiltinTemplatesIdempotent(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	if err := seedBuiltinTemplates(ctx, s.DB); err != nil {
		t.Fatal(err)
	}
	if err := seedBuiltinTemplates(ctx, s.DB); err != nil { // second call must not duplicate
		t.Fatal(err)
	}
	ts, _ := s.ListTemplates(ctx)
	builtins := 0
	for _, tpl := range ts {
		if tpl.Builtin {
			builtins++
		}
	}
	if builtins != len(PredefinedTemplates) {
		t.Fatalf("builtins=%d want %d", builtins, len(PredefinedTemplates))
	}
}

func TestParseTemplate_GeneralAndMITM(t *testing.T) {
	spec, err := ParseTemplate(`{"final":"PROXY","general":"dns-server = 1.1.1.1","mitm":"hostname = *.x.com"}`)
	if err != nil {
		t.Fatal(err)
	}
	if spec.General != "dns-server = 1.1.1.1" {
		t.Fatalf("general = %q", spec.General)
	}
	if spec.MITM != "hostname = *.x.com" {
		t.Fatalf("mitm = %q", spec.MITM)
	}
}
