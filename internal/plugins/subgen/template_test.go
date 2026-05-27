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

func TestParseTemplate_ClashGeneral(t *testing.T) {
	// valid YAML object accepted
	if _, err := ParseTemplate(`{"final":"PROXY","clash_general":"mode: rule\ndns:\n  enable: true"}`); err != nil {
		t.Fatalf("valid clash_general rejected: %v", err)
	}
	// malformed YAML rejected
	if _, err := ParseTemplate(`{"final":"PROXY","clash_general":"x: [1, 2"}`); err == nil {
		t.Fatal("malformed clash_general accepted")
	}
	// non-object YAML (bare scalar) rejected
	if _, err := ParseTemplate(`{"final":"PROXY","clash_general":"just a string"}`); err == nil {
		t.Fatal("scalar clash_general accepted")
	}
}

func TestParseTemplate_CustomGroups(t *testing.T) {
	ok := `{"final":"PROXY","custom_groups":[{"name":"Home","type":"select","members":["DEVICE:HomeMac","DIRECT"]}]}`
	spec, err := ParseTemplate(ok)
	if err != nil {
		t.Fatalf("valid rejected: %v", err)
	}
	if len(spec.CustomGroups) != 1 || spec.CustomGroups[0].Name != "Home" ||
		spec.CustomGroups[0].Type != "select" || len(spec.CustomGroups[0].Members) != 2 {
		t.Fatalf("parsed = %+v", spec.CustomGroups)
	}
	for _, bad := range []string{
		`{"custom_groups":[{"name":"","type":"select","members":["x"]}]}`,
		`{"custom_groups":[{"name":"H","type":"fallback","members":["x"]}]}`,
		`{"custom_groups":[{"name":"H","type":"select","members":[]}]}`,
	} {
		if _, err := ParseTemplate(bad); err == nil {
			t.Fatalf("bad custom group accepted: %s", bad)
		}
	}
}
