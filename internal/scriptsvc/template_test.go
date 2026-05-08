package scriptsvc

import "testing"

func TestRender_Substitution(t *testing.T) {
	out, err := Render("echo {{.name}}", []Param{{Name: "name", Required: true}}, map[string]string{"name": "world"})
	if err != nil {
		t.Fatal(err)
	}
	if out != "echo world" {
		t.Fatalf("out=%q", out)
	}
}

func TestRender_MissingRequired(t *testing.T) {
	_, err := Render("echo {{.name}}", []Param{{Name: "name", Required: true}}, map[string]string{})
	if err == nil {
		t.Fatal("expected error for missing required param")
	}
}

func TestRender_BadParamName(t *testing.T) {
	_, err := Render("x", []Param{{Name: "bad name"}}, map[string]string{})
	if err == nil {
		t.Fatal("expected error for bad param name")
	}
}

func TestRender_DefaultUsed(t *testing.T) {
	out, err := Render("echo {{.color}}", []Param{{Name: "color", Default: "blue"}}, map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	if out != "echo blue" {
		t.Fatalf("out=%q", out)
	}
}
