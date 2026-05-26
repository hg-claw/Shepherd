package subgen

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

type CategorySel struct {
	Name   string `json:"name"`
	Policy string `json:"policy"`
}

type CustomRule struct {
	Match  string `json:"match"`
	Policy string `json:"policy"`
}

type TemplateSpec struct {
	Categories        []CategorySel `json:"categories"`
	CustomRules       []CustomRule  `json:"custom_rules"`
	Final             string        `json:"final"`
	GroupByCountry    bool          `json:"group_by_country"`
	IncludeAutoSelect bool          `json:"include_auto_select"`
}

func validPolicy(p string) bool {
	switch p {
	case "PROXY", "DIRECT", "REJECT":
		return true
	default:
		return p != "" // named group allowed; empty is not
	}
}

func ParseTemplate(rulesJSON string) (TemplateSpec, error) {
	var t TemplateSpec
	if err := json.Unmarshal([]byte(rulesJSON), &t); err != nil {
		return t, fmt.Errorf("bad rules_json: %w", err)
	}
	if t.Final == "" {
		t.Final = "PROXY"
	}
	for _, c := range t.Categories {
		if _, ok := categoryByName(c.Name); !ok {
			return t, fmt.Errorf("unknown category %q", c.Name)
		}
		if !validPolicy(c.Policy) {
			return t, fmt.Errorf("bad policy %q for %q", c.Policy, c.Name)
		}
	}
	for _, r := range t.CustomRules {
		if r.Match == "" || !validPolicy(r.Policy) {
			return t, fmt.Errorf("bad custom rule %+v", r)
		}
	}
	return t, nil
}

func builtinSpec(setName string) TemplateSpec {
	t := TemplateSpec{Final: "PROXY", GroupByCountry: true, IncludeAutoSelect: true}
	for _, name := range PredefinedTemplates[setName] {
		c, _ := categoryByName(name)
		t.Categories = append(t.Categories, CategorySel{Name: name, Policy: c.DefaultPolicy})
	}
	return t
}

func seedBuiltinTemplates(ctx context.Context, db *sqlx.DB) error {
	now := time.Now().UTC()
	for setName := range PredefinedTemplates {
		spec := builtinSpec(setName)
		raw, _ := json.Marshal(spec)
		var n int
		if err := db.GetContext(ctx, &n,
			`SELECT COUNT(*) FROM subgen_templates WHERE name=$1 AND builtin=true`, setName); err != nil {
			return err
		}
		if n > 0 {
			continue
		}
		if _, err := db.ExecContext(ctx,
			`INSERT INTO subgen_templates(name, builtin, rules_json, created_at, updated_at)
			 VALUES ($1,true,$2,$3,$3)`, setName, string(raw), now); err != nil {
			return err
		}
	}
	return nil
}
