# Clash Output + Cross-Format Model + Usage Doc — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Clash.Meta (mihomo) YAML output target to the subgen plugin, refactoring the renderer model to a semantic intermediate so each format renders its own rules/rule-sets, with per-format free-text sections and a user-facing usage doc.

**Architecture:** `Assemble` produces a semantic `Intermediate` (`Rules []Rule`, not pre-baked Surge strings). Each renderer formats per target: Surge `.conf` (output byte-for-byte unchanged) and a new Clash YAML renderer. Surge-only `[General]`/`[MITM]` stay Surge-only; Clash gets its own `clash_general` YAML preamble. `gopkg.in/yaml.v3` marshals Clash output.

**Tech Stack:** Go (`internal/plugins/subgen`), `gopkg.in/yaml.v3`, React/TypeScript (`web/src/pages/admin/plugins/subgen`). Spec: `docs/superpowers/specs/2026-05-26-clash-output-and-cross-format-design.md`.

**Working directory:** repo root `/Users/hg/project/Shepherd`, branch `feat/subgen-plugin`.

**Conventions (learned on this plugin):**
- Run Go commands from the repo root (a stray `cd web` persists across Bash calls).
- `go build ./...` leaves no binary; if a subagent runs `go build ./cmd/server`, `rm -f server` after.
- Do NOT run `npm run build` during tasks (it deletes a tracked `.gitkeep`). FE gates are `npx tsc --noEmit` and `npx vitest run` from `web/`.
- Boolean SQL columns use `true`/`false` — not relevant here (no migration).

---

## File Structure

| File | Change |
|------|--------|
| `go.mod` / `go.sum` | add `gopkg.in/yaml.v3` |
| `internal/plugins/subgen/template.go` | `TemplateSpec.ClashGeneral`; `ParseTemplate` validates it as YAML |
| `internal/plugins/subgen/catalog.go` | add `rulesetURL`; `rulesetDir` clash branch; `ResolveRuleLines` reimplemented atop `rulesetURL` (kept for `/categories`) |
| `internal/plugins/subgen/base.go` | `Rule` type; `Intermediate.Rules []Rule` + `ClashGeneral`; `Assemble(nodes, spec)` builds semantic rules |
| `internal/plugins/subgen/render.go` | `Render(im, subURL, rulesetBase)`; later add `clash` case |
| `internal/plugins/subgen/render_surge.go` | consume `[]Rule` (output unchanged); `Render` gains `rulesetBase` |
| `internal/plugins/subgen/render_clash.go` | NEW — Clash YAML renderer |
| `internal/plugins/subgen/service.go` | new `Assemble`/`Render` call sites |
| tests | `template_test.go`, `catalog_test.go`, `base_test.go`, `render_surge_test.go`, `render_clash_test.go` (new), `service_test.go`, `routes_test.go` |
| `web/.../SubscriptionsTab.tsx`, `TemplatesTab.tsx` | add `clash` target option + `clash_general` editor field |
| `docs/subgen.md` | NEW — usage guide |

---

## Task 1: Add `gopkg.in/yaml.v3` + `clash_general` field + parse validation

**Files:**
- Modify: `go.mod`, `go.sum`, `internal/plugins/subgen/template.go`
- Test: `internal/plugins/subgen/template_test.go`

- [ ] **Step 1: Add the dependency**

Run: `go get gopkg.in/yaml.v3`
Expected: `go.mod`/`go.sum` gain the `gopkg.in/yaml.v3` line. (It becomes a direct dep once imported in Step 4.)

- [ ] **Step 2: Write the failing test**

Add to `internal/plugins/subgen/template_test.go`:

```go
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestParseTemplate_ClashGeneral`
Expected: FAIL — build error `spec.ClashGeneral`/field unknown, or (once the field exists) the malformed/scalar cases pass through because validation isn't there yet.

- [ ] **Step 4: Add the field + validation**

In `internal/plugins/subgen/template.go`, replace the `TemplateSpec` struct:

```go
type TemplateSpec struct {
	Categories        []CategorySel `json:"categories"`
	CustomRules       []CustomRule  `json:"custom_rules"`
	Final             string        `json:"final"`
	IncludeAutoSelect bool          `json:"include_auto_select"`
	General           string        `json:"general,omitempty"`       // Surge [General] body
	MITM              string        `json:"mitm,omitempty"`          // Surge [MITM] body
	ClashGeneral      string        `json:"clash_general,omitempty"` // Clash YAML preamble (top-level keys)
}
```

Add the `gopkg.in/yaml.v3` import to the import block, and insert the validation into `ParseTemplate` right after the `if t.Final == "" { t.Final = "PROXY" }` line:

```go
	if t.ClashGeneral != "" {
		var m map[string]any
		if err := yaml.Unmarshal([]byte(t.ClashGeneral), &m); err != nil {
			return t, fmt.Errorf("bad clash_general: %w", err)
		}
	}
```

(`yaml.Unmarshal` of a bare scalar into `map[string]any` errors, which is the behavior the scalar test relies on.)

- [ ] **Step 5: Tidy modules + run tests**

Run: `go mod tidy && go test ./internal/plugins/subgen/ -run TestParseTemplate`
Expected: PASS (new test + existing `TestTemplateValidate`). `go.mod` lists `gopkg.in/yaml.v3` as a direct dependency.

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum internal/plugins/subgen/template.go internal/plugins/subgen/template_test.go
git commit -m "feat(subgen): add clash_general field + YAML validation; add yaml.v3 dep"
```

---

## Task 2: catalog — `rulesetURL` + clash dir; keep `ResolveRuleLines`

**Files:**
- Modify: `internal/plugins/subgen/catalog.go`
- Test: `internal/plugins/subgen/catalog_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/plugins/subgen/catalog_test.go`:

```go
func TestRulesetURL_SurgeAndClash(t *testing.T) {
	base := "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master"
	if got := rulesetURL("Telegram", "surge", base); got != base+"/rule/Surge/Telegram/Telegram.list" {
		t.Fatalf("surge url = %s", got)
	}
	if got := rulesetURL("Telegram", "shadowrocket", base); got != base+"/rule/Surge/Telegram/Telegram.list" {
		t.Fatalf("shadowrocket url = %s", got)
	}
	if got := rulesetURL("Telegram", "clash", base); got != base+"/rule/Clash/Telegram/Telegram.yaml" {
		t.Fatalf("clash url = %s", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestRulesetURL_SurgeAndClash`
Expected: FAIL — build error `undefined: rulesetURL`.

- [ ] **Step 3: Implement**

In `internal/plugins/subgen/catalog.go`, replace `rulesetDir` and `ResolveRuleLines` with:

```go
// rulesetDir maps a target to the blackmatrix7 rule directory + file ext.
// Surge and ShadowRocket both consume Surge-format .list files; Clash consumes
// .yaml rule-provider files.
func rulesetDir(target string) (dir, ext string) {
	if target == "clash" {
		return "Clash", "yaml"
	}
	return "Surge", "list"
}

// rulesetURL builds the blackmatrix7 raw URL for one folder + target.
func rulesetURL(folder, target, base string) string {
	dir, ext := rulesetDir(target)
	base = strings.TrimRight(base, "/")
	return base + "/rule/" + dir + "/" + folder + "/" + folder + "." + ext
}

// ResolveRuleLines turns one category + policy into the rule line(s) for a
// target. Used by the /categories admin endpoint to surface display rule lines.
// (Assemble no longer uses this; it emits semantic rules and the renderers call
// rulesetURL.)
func ResolveRuleLines(category, policy, target, base string) []string {
	c, ok := categoryByName(category)
	if !ok {
		return nil
	}
	if c.Native != "" {
		return []string{c.Native + "," + policy}
	}
	var out []string
	for _, rs := range c.Rulesets {
		out = append(out, "RULE-SET,"+rulesetURL(rs, target, base)+","+policy)
	}
	return out
}
```

(The `strings` import is already present in `catalog.go`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/ -run 'TestRulesetURL_SurgeAndClash|TestResolveRuleLines'`
Expected: PASS (new test + the existing `TestResolveRuleLines_RemoteAndNative`, whose Surge behavior is unchanged).

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/catalog.go internal/plugins/subgen/catalog_test.go
git commit -m "feat(subgen): rulesetURL primitive + Clash ruleset dir"
```

---

## Task 3: Semantic `Intermediate` — `[]Rule`, renderer signature, Surge unchanged

This task lands atomically across `base.go`, `render.go`, `render_surge.go`, `service.go`, and their tests (Go compiles the whole package). Surge/ShadowRocket output must be byte-for-byte unchanged; `clash` is still rejected after this task.

**Files:**
- Modify: `internal/plugins/subgen/base.go`, `render.go`, `render_surge.go`, `service.go`
- Test: `internal/plugins/subgen/base_test.go`, `render_surge_test.go`

- [ ] **Step 1: Rewrite the base test**

Replace the ENTIRE contents of `internal/plugins/subgen/base_test.go` with:

```go
package subgen

import "testing"

func TestAssemble_GroupsAndRules(t *testing.T) {
	nodes := []Node{
		{Name: "🇯🇵 tokyo vless", Protocol: "vless", Server: "1.1.1.1", Port: 443, Country: "JP"},
		{Name: "🇸🇬 sg ss", Protocol: "shadowsocks", Server: "2.2.2.2", Port: 8388, Country: "SG"},
	}
	spec := TemplateSpec{
		Categories:        []CategorySel{{Name: "Telegram", Policy: "PROXY"}, {Name: "Location:CN", Policy: "DIRECT"}},
		CustomRules:       []CustomRule{{Match: "IP-CIDR,10.0.0.0/24", Policy: "PROXY"}},
		Final:             "PROXY",
		IncludeAutoSelect: true,
	}
	im := Assemble(nodes, spec)

	// PROXY first; Auto Select present; no country groups.
	if len(im.Groups) == 0 || im.Groups[0].Name != "PROXY" {
		t.Fatalf("PROXY not first: %+v", im.Groups)
	}
	if findGroup(im.Groups, "Auto Select") == nil {
		t.Fatal("missing Auto Select group")
	}
	if findGroup(im.Groups, "🇯🇵 JP") != nil || findGroup(im.Groups, "🇸🇬 SG") != nil {
		t.Fatalf("country groups should be gone: %+v", im.Groups)
	}
	tg := findGroup(im.Groups, "Telegram")
	if tg == nil || tg.Type != "select" {
		t.Fatalf("Telegram group missing/wrong: %+v", tg)
	}
	wantTG := []string{"PROXY", "DIRECT", "REJECT", "🇯🇵 tokyo vless", "🇸🇬 sg ss"}
	if !equalStrings(tg.Members, wantTG) {
		t.Fatalf("Telegram members = %v want %v", tg.Members, wantTG)
	}

	// Semantic rules: custom first, Final last, categories route to group name.
	if r0 := im.Rules[0]; r0.Match != "IP-CIDR,10.0.0.0/24" || r0.Target != "PROXY" {
		t.Fatalf("custom rule not first: %+v", r0)
	}
	if last := im.Rules[len(im.Rules)-1]; !last.Final || last.Target != "PROXY" {
		t.Fatalf("final not last: %+v", last)
	}
	if !hasRule(im.Rules, Rule{Ruleset: "Telegram", Target: "Telegram"}) {
		t.Fatalf("telegram ruleset rule missing: %+v", im.Rules)
	}
	if !hasRule(im.Rules, Rule{Native: "GEOIP,CN", Target: "Location:CN"}) {
		t.Fatalf("cn native rule missing: %+v", im.Rules)
	}

	// General/MITM/ClashGeneral propagate.
	spec2 := spec
	spec2.General = "g"
	spec2.MITM = "m"
	spec2.ClashGeneral = "mode: rule"
	im2 := Assemble(nodes, spec2)
	if im2.General != "g" || im2.MITM != "m" || im2.ClashGeneral != "mode: rule" {
		t.Fatalf("general/mitm/clash not propagated: %q/%q/%q", im2.General, im2.MITM, im2.ClashGeneral)
	}
}

func findGroup(gs []Group, name string) *Group {
	for i := range gs {
		if gs[i].Name == name {
			return &gs[i]
		}
	}
	return nil
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func hasRule(rules []Rule, want Rule) bool {
	for _, r := range rules {
		if r == want {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Run it, expect failure**

Run: `go test ./internal/plugins/subgen/ -run TestAssemble_GroupsAndRules`
Expected: FAIL — build errors (`Assemble` arity, `Rule` undefined, `im.Rules[0].Match` on `string`).

- [ ] **Step 3: Rewrite `base.go`**

Replace the ENTIRE contents of `internal/plugins/subgen/base.go` with:

```go
package subgen

type Group struct {
	Name    string
	Type    string // "select" | "url-test"
	Members []string
}

// Rule is one routing entry in target-agnostic form. Exactly one of Ruleset /
// Native / Match is set, OR Final is true (the catch-all). Target is the policy
// or proxy-group name matched traffic is routed to.
type Rule struct {
	Ruleset string // remote rule-set folder name (blackmatrix7); a category may expand to several
	Native  string // built-in matcher emitted ~verbatim, e.g. "GEOIP,CN" or "RULE-SET,SYSTEM"
	Match   string // custom rule body, e.g. "DOMAIN-SUFFIX,example.com"
	Final   bool   // catch-all (Surge: FINAL / Clash: MATCH)
	Target  string
}

type Intermediate struct {
	Nodes        []Node
	Groups       []Group
	Rules        []Rule
	General      string // Surge [General] body; empty → renderer default
	MITM         string // Surge [MITM] body; empty → section omitted
	ClashGeneral string // Clash YAML preamble; empty → {mode: rule}
}

const autoSelectGroup = "Auto Select"
const mainProxyGroup = "PROXY"

// Assemble builds the target-agnostic model.
//
// Groups, in order: the main "PROXY" select (members = optional "Auto Select"
// then every node name), an "Auto Select" url-test (only if IncludeAutoSelect),
// then one switchable "select" group per category. A category group is named
// after the category; its members are the configured policy (first → default
// selection), PROXY, DIRECT, REJECT, then every node — de-duplicated.
//
// Rules (semantic): custom rules first (explicit policy), then one rule per
// category routed to the category's GROUP by name, then the catch-all (Final).
// The free-text General/MITM/ClashGeneral blocks ride along to the renderer,
// which resolves rule-set URLs for its own target.
func Assemble(nodes []Node, spec TemplateSpec) Intermediate {
	im := Intermediate{Nodes: nodes, General: spec.General, MITM: spec.MITM, ClashGeneral: spec.ClashGeneral}

	allNames := make([]string, 0, len(nodes))
	for _, n := range nodes {
		allNames = append(allNames, n.Name)
	}

	mainMembers := []string{}
	if spec.IncludeAutoSelect {
		mainMembers = append(mainMembers, autoSelectGroup)
	}
	mainMembers = append(mainMembers, allNames...)
	im.Groups = append(im.Groups, Group{Name: mainProxyGroup, Type: "select", Members: mainMembers})
	if spec.IncludeAutoSelect {
		im.Groups = append(im.Groups, Group{Name: autoSelectGroup, Type: "url-test", Members: allNames})
	}

	for _, c := range spec.Categories {
		members := dedupeStrings(append([]string{c.Policy, mainProxyGroup, "DIRECT", "REJECT"}, allNames...))
		im.Groups = append(im.Groups, Group{Name: c.Name, Type: "select", Members: members})
	}

	for _, r := range spec.CustomRules {
		im.Rules = append(im.Rules, Rule{Match: r.Match, Target: r.Policy})
	}
	for _, c := range spec.Categories {
		cat, _ := categoryByName(c.Name) // categories are validated by ParseTemplate
		if cat.Native != "" {
			im.Rules = append(im.Rules, Rule{Native: cat.Native, Target: c.Name})
		} else {
			for _, folder := range cat.Rulesets {
				im.Rules = append(im.Rules, Rule{Ruleset: folder, Target: c.Name})
			}
		}
	}
	im.Rules = append(im.Rules, Rule{Final: true, Target: spec.Final})
	return im
}

// dedupeStrings drops later duplicates, preserving first-seen order. Keeps a
// category group's default policy from repeating when it equals one of the
// standard PROXY/DIRECT/REJECT members.
func dedupeStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
```

- [ ] **Step 4: Update the `Renderer` interface (`render.go`)**

Replace the ENTIRE contents of `internal/plugins/subgen/render.go` with:

```go
package subgen

type Renderer interface {
	Target() string
	Supports(protocol string) bool
	Render(im Intermediate, subURL, rulesetBase string) string
}

func rendererFor(target string) (Renderer, bool) {
	switch target {
	case "surge":
		return &SurgeRenderer{}, true
	case "shadowrocket":
		return &ShadowRocketRenderer{}, true
	default:
		return nil, false
	}
}
```

- [ ] **Step 5: Update `render_surge.go`**

(a) Change the `Render` signature line from:
```go
func (r *SurgeRenderer) Render(im Intermediate, subURL string) string {
```
to:
```go
func (r *SurgeRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
```

(b) Replace the rule loop:
```go
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(rule + "\n")
	}
```
with:
```go
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(surgeRuleLine(rule, rulesetBase) + "\n")
	}
```

(c) Add this helper at the end of the file:
```go
// surgeRuleLine formats one semantic Rule as a Surge [Rule] line.
func surgeRuleLine(r Rule, rulesetBase string) string {
	switch {
	case r.Final:
		return "FINAL," + r.Target
	case r.Ruleset != "":
		return "RULE-SET," + rulesetURL(r.Ruleset, "surge", rulesetBase) + "," + r.Target
	case r.Native != "":
		return r.Native + "," + r.Target
	default:
		return r.Match + "," + r.Target
	}
}
```

- [ ] **Step 6: Update `service.go` call sites**

In `Generate`, replace:
```go
	im := Assemble(nodes, spec, target, s.base())
	subURL := fmt.Sprintf("%s/sub/%s?target=%s", s.PublicURL, token, target)
	return r.Render(im, subURL), "text/plain; charset=utf-8", nil
```
with:
```go
	im := Assemble(nodes, spec)
	subURL := fmt.Sprintf("%s/sub/%s?target=%s", s.PublicURL, token, target)
	return r.Render(im, subURL, s.base()), "text/plain; charset=utf-8", nil
```

In `PreviewTemplate`, replace:
```go
	im := Assemble(sampleNodes(), spec, target, s.base())
	subURL := fmt.Sprintf("%s/sub/PREVIEW?target=%s", s.PublicURL, target)
	return r.Render(im, subURL), "text/plain; charset=utf-8", nil
```
with:
```go
	im := Assemble(sampleNodes(), spec)
	subURL := fmt.Sprintf("%s/sub/PREVIEW?target=%s", s.PublicURL, target)
	return r.Render(im, subURL, s.base()), "text/plain; charset=utf-8", nil
```

- [ ] **Step 7: Update `render_surge_test.go`**

Replace the ENTIRE contents of `internal/plugins/subgen/render_surge_test.go` with (note: `[]Rule` fixtures, new `Render` 3-arg signature, and a new RULE-SET assertion proving URL building):

```go
package subgen

import (
	"strings"
	"testing"
)

func TestSurge_RendersProtocolsGroupsRules(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "ss1", Protocol: "shadowsocks", Server: "1.1.1.1", Port: 8388, SSMethod: "aes-256-gcm", Password: "p"},
			{Name: "re1", Protocol: "vless", Server: "2.2.2.2", Port: 443, UUID: "u", SNI: "s", RealityPublicKey: "PBK", RealityShortID: "aa"},
			{Name: "hy1", Protocol: "hysteria2", Server: "3.3.3.3", Port: 443, Password: "hp", SNI: "h"},
			{Name: "at1", Protocol: "anytls", Server: "4.4.4.4", Port: 443, Password: "ap", SNI: "a"},
		},
		Groups: []Group{
			{Name: "PROXY", Type: "select", Members: []string{"Auto Select", "ss1"}},
			{Name: "Auto Select", Type: "url-test", Members: []string{"ss1", "re1"}},
		},
		Rules: []Rule{
			{Match: "IP-CIDR,10.0.0.0/24", Target: "PROXY"},
			{Ruleset: "Telegram", Target: "Telegram"},
			{Native: "GEOIP,CN", Target: "DIRECT"},
			{Final: true, Target: "PROXY"},
		},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x/sub/abc?target=surge", DefaultRulesetBase)
	for _, want := range []string{
		"#!MANAGED-CONFIG https://x/sub/abc?target=surge",
		"[Proxy]", "DIRECT = direct",
		"ss1 = ss, 1.1.1.1, 8388, encrypt-method=aes-256-gcm, password=p",
		"re1 = vless, 2.2.2.2, 443, username=u, tls=true, sni=s, public-key=PBK, short-id=aa",
		"hy1 = hysteria2, 3.3.3.3, 443, password=hp, sni=h",
		"at1 = anytls, 4.4.4.4, 443, password=ap, sni=a",
		"[Proxy Group]",
		"PROXY = select, Auto Select, ss1, DIRECT",
		"Auto Select = url-test, ss1, re1, url=http://www.gstatic.com/generate_204, interval=300",
		"[Rule]",
		"IP-CIDR,10.0.0.0/24,PROXY",
		"RULE-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Surge/Telegram/Telegram.list,Telegram",
		"GEOIP,CN,DIRECT",
		"FINAL,PROXY",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q\n---\n%s", want, out)
		}
	}
}

func TestSurge_GeneralAndMITM(t *testing.T) {
	base := Intermediate{
		Nodes:  []Node{{Name: "n1", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p"}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}

	out := (&SurgeRenderer{}).Render(base, "https://x/sub/t?target=surge", DefaultRulesetBase)
	if !strings.Contains(out, "[General]\nbypass-system = true") {
		t.Fatalf("default [General] missing:\n%s", out)
	}
	if strings.Contains(out, "[MITM]") {
		t.Fatalf("[MITM] should be absent when unset:\n%s", out)
	}

	im := base
	im.General = "dns-server = 1.1.1.1\nskip-proxy = 10.0.0.0/8"
	im.MITM = "hostname = *.googlevideo.com"
	out = (&SurgeRenderer{}).Render(im, "https://x/sub/t?target=surge", DefaultRulesetBase)
	if !strings.Contains(out, "[General]\ndns-server = 1.1.1.1\nskip-proxy = 10.0.0.0/8") {
		t.Fatalf("custom [General] missing:\n%s", out)
	}
	if strings.Contains(out, "bypass-system = true") {
		t.Fatalf("default [General] should be replaced:\n%s", out)
	}
	if !strings.Contains(out, "[MITM]\nhostname = *.googlevideo.com") {
		t.Fatalf("[MITM] missing:\n%s", out)
	}
}

func TestSurge_SelectGroupDirectFallback(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"Auto Select", "n1"}}},
	}
	out := (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "PROXY = select, Auto Select, n1, DIRECT\n") {
		t.Fatalf("missing DIRECT fallback:\n%s", out)
	}

	im2 := Intermediate{
		Groups: []Group{{Name: "Telegram", Type: "select", Members: []string{"PROXY", "DIRECT", "REJECT", "n1"}}},
	}
	out2 := (&SurgeRenderer{}).Render(im2, "x", DefaultRulesetBase)
	if !strings.Contains(out2, "Telegram = select, PROXY, DIRECT, REJECT, n1\n") {
		t.Fatalf("Telegram group wrong:\n%s", out2)
	}
	if strings.Contains(out2, "REJECT, n1, DIRECT") {
		t.Fatalf("DIRECT duplicated:\n%s", out2)
	}
}

func TestSurge_ProxyLine_VmessTrojanTuic(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "vm1", Protocol: "vmess", Server: "1.1.1.1", Port: 443, UUID: "uu", SNI: "v.com", Transport: "ws", Path: "/p", Host: "v.com"},
			{Name: "tj1", Protocol: "trojan", Server: "2.2.2.2", Port: 443, Password: "tp", SNI: "t.com"},
			{Name: "tu1", Protocol: "tuic", Server: "3.3.3.3", Port: 443, Password: "up", UUID: "uid", SNI: "u.com", Extra: map[string]any{"congestion_control": "bbr"}},
		},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"vm1"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x/sub/t?target=surge", DefaultRulesetBase)
	for _, want := range []string{
		"vm1 = vmess, 1.1.1.1, 443, username=uu, vmess-aead=true, tls=true, sni=v.com, ws=true, ws-path=/p, ws-headers=Host:v.com",
		"tj1 = trojan, 2.2.2.2, 443, password=tp, sni=t.com",
		"tu1 = tuic, 3.3.3.3, 443, password=up, uuid=uid, sni=u.com, congestion-controller=bbr",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q\n---\n%s", want, out)
		}
	}
}
```

- [ ] **Step 8: Run the package**

Run: `go test ./internal/plugins/subgen/`
Expected: PASS. (`service_test.go`/`routes_test.go` still compile: they call `Generate`/`PreviewTemplate`, whose signatures are unchanged; the internal `Assemble`/`Render` calls were updated.)

- [ ] **Step 9: gofmt + commit**

Run: `gofmt -l internal/plugins/subgen/` → expect no output.

```bash
git add internal/plugins/subgen/base.go internal/plugins/subgen/base_test.go internal/plugins/subgen/render.go internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_surge_test.go internal/plugins/subgen/service.go
git commit -m "refactor(subgen): semantic Intermediate rules; renderer resolves ruleset URLs"
```

---

## Task 4: Clash renderer + wire `clash` target

**Files:**
- Create: `internal/plugins/subgen/render_clash.go`, `internal/plugins/subgen/render_clash_test.go`
- Modify: `internal/plugins/subgen/render.go`, `service_test.go`, `routes_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/plugins/subgen/render_clash_test.go`:

```go
package subgen

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestClash_RendersYAML(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{
			{Name: "🇺🇸 us trojan", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p", SNI: "x.com"},
			{Name: "🇭🇰 hk ss", Protocol: "shadowsocks", Server: "2.2.2.2", Port: 8388, SSMethod: "aes-128-gcm", Password: "pw"},
		},
		Groups: []Group{
			{Name: "PROXY", Type: "select", Members: []string{"Auto Select", "🇺🇸 us trojan", "🇭🇰 hk ss"}},
			{Name: "Auto Select", Type: "url-test", Members: []string{"🇺🇸 us trojan", "🇭🇰 hk ss"}},
			{Name: "Telegram", Type: "select", Members: []string{"PROXY", "DIRECT", "REJECT", "🇺🇸 us trojan"}},
		},
		Rules: []Rule{
			{Match: "IP-CIDR,10.0.0.0/24", Target: "PROXY"},
			{Ruleset: "Telegram", Target: "Telegram"},
			{Native: "GEOIP,CN", Target: "Location:CN"},
			{Native: "RULE-SET,SYSTEM", Target: "Private"},
			{Final: true, Target: "PROXY"},
		},
		ClashGeneral: "dns:\n  enable: true",
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)

	// Parses as YAML.
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	if _, ok := doc["dns"]; !ok {
		t.Fatalf("clash_general not injected:\n%s", out)
	}
	if doc["proxies"] == nil || doc["proxy-groups"] == nil || doc["rule-providers"] == nil {
		t.Fatalf("missing sections:\n%s", out)
	}
	for _, want := range []string{
		"RULE-SET,Telegram,Telegram",
		"GEOIP,CN,Location:CN",
		"GEOIP,PRIVATE,Private",
		"IP-CIDR,10.0.0.0/24,PROXY",
		"MATCH,PROXY",
		"behavior: classical",
		"/rule/Clash/Telegram/Telegram.yaml",
		"type: trojan",
		"type: ss",
		"🇺🇸 us trojan",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("clash output missing %q\n---\n%s", want, out)
		}
	}
	if strings.Contains(out, "FINAL,") {
		t.Fatalf("should use MATCH not FINAL:\n%s", out)
	}

	// Empty ClashGeneral → default mode: rule.
	im2 := im
	im2.ClashGeneral = ""
	out2 := (&ClashRenderer{}).Render(im2, "", DefaultRulesetBase)
	if !strings.Contains(out2, "mode: rule") {
		t.Fatalf("default mode missing:\n%s", out2)
	}
}
```

- [ ] **Step 2: Run it, expect failure**

Run: `go test ./internal/plugins/subgen/ -run TestClash_RendersYAML`
Expected: FAIL — build error `undefined: ClashRenderer`.

- [ ] **Step 3: Create `render_clash.go`**

```go
package subgen

import (
	"strings"

	"gopkg.in/yaml.v3"
)

type ClashRenderer struct{}

func (*ClashRenderer) Target() string { return "clash" }

func (*ClashRenderer) Supports(p string) bool {
	switch p {
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls":
		return true
	}
	return false
}

// Render produces a mihomo (Clash.Meta) YAML config. subURL is unused (Clash has
// no managed-config header). The ClashGeneral preamble supplies top-level keys
// (dns, mode, …); when empty the default is {mode: rule}.
func (r *ClashRenderer) Render(im Intermediate, _ string, rulesetBase string) string {
	base := map[string]any{"mode": "rule"}
	if g := strings.TrimSpace(im.ClashGeneral); g != "" {
		var m map[string]any
		if err := yaml.Unmarshal([]byte(g), &m); err == nil && m != nil {
			base = m
		}
	}

	proxies := []map[string]any{}
	for _, n := range im.Nodes {
		if px := clashProxy(n); px != nil {
			proxies = append(proxies, px)
		}
	}
	if len(proxies) > 0 {
		base["proxies"] = proxies
	}

	groups := []map[string]any{}
	for _, g := range im.Groups {
		m := map[string]any{"name": g.Name, "type": g.Type, "proxies": g.Members}
		if g.Type == "url-test" {
			m["url"] = "http://www.gstatic.com/generate_204"
			m["interval"] = 300
		}
		groups = append(groups, m)
	}
	if len(groups) > 0 {
		base["proxy-groups"] = groups
	}

	providers := map[string]any{}
	rules := []string{}
	for _, rl := range im.Rules {
		switch {
		case rl.Final:
			rules = append(rules, "MATCH,"+rl.Target)
		case rl.Ruleset != "":
			if _, ok := providers[rl.Ruleset]; !ok {
				providers[rl.Ruleset] = map[string]any{
					"type":     "http",
					"behavior": "classical",
					"format":   "yaml",
					"url":      rulesetURL(rl.Ruleset, "clash", rulesetBase),
					"path":     "./ruleset/" + rl.Ruleset + ".yaml",
					"interval": 86400,
				}
			}
			rules = append(rules, "RULE-SET,"+rl.Ruleset+","+rl.Target)
		case rl.Native != "":
			rules = append(rules, nativeToClash(rl.Native)+","+rl.Target)
		default:
			rules = append(rules, rl.Match+","+rl.Target)
		}
	}
	if len(providers) > 0 {
		base["rule-providers"] = providers
	}
	base["rules"] = rules

	out, err := yaml.Marshal(base)
	if err != nil {
		return "# clash render error: " + err.Error()
	}
	return string(out)
}

// nativeToClash maps a catalog Native directive to its Clash rule prefix. Clash
// has no SYSTEM rule-set, so the Private category maps to GEOIP,PRIVATE (mihomo's
// LAN/loopback group); everything else (e.g. GEOIP,CN) is identical.
func nativeToClash(native string) string {
	if native == "RULE-SET,SYSTEM" {
		return "GEOIP,PRIVATE"
	}
	return native
}

// clashProxy maps a Node to a mihomo proxy map, or nil if unsupported.
func clashProxy(n Node) map[string]any {
	p := map[string]any{"name": n.Name, "server": n.Server, "port": n.Port}
	switch n.Protocol {
	case "shadowsocks":
		p["type"] = "ss"
		p["cipher"] = n.SSMethod
		p["password"] = n.Password
	case "vmess":
		p["type"] = "vmess"
		p["uuid"] = n.UUID
		p["alterId"] = 0
		p["cipher"] = "auto"
		if n.SNI != "" {
			p["tls"] = true
			p["servername"] = n.SNI
			if n.Insecure {
				p["skip-cert-verify"] = true
			}
		}
		if n.Transport == "ws" {
			p["network"] = "ws"
			p["ws-opts"] = clashWSOpts(n)
		}
	case "trojan":
		p["type"] = "trojan"
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
		if n.Transport == "ws" {
			p["network"] = "ws"
			p["ws-opts"] = clashWSOpts(n)
		}
	case "vless":
		p["type"] = "vless"
		p["uuid"] = n.UUID
		p["tls"] = true
		if n.SNI != "" {
			p["servername"] = n.SNI
		}
		if n.Flow != "" {
			p["flow"] = n.Flow
		}
		if n.RealityPublicKey != "" {
			p["reality-opts"] = map[string]any{"public-key": n.RealityPublicKey, "short-id": n.RealityShortID}
			p["client-fingerprint"] = "chrome"
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
		if n.Transport == "ws" {
			p["network"] = "ws"
			p["ws-opts"] = clashWSOpts(n)
		}
	case "hysteria2":
		p["type"] = "hysteria2"
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
	case "tuic":
		p["type"] = "tuic"
		p["uuid"] = n.UUID
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if cc, ok := n.Extra["congestion_control"].(string); ok && cc != "" {
			p["congestion-controller"] = cc
		}
	case "anytls":
		p["type"] = "anytls"
		p["password"] = n.Password
		if n.SNI != "" {
			p["sni"] = n.SNI
		}
		if n.Insecure {
			p["skip-cert-verify"] = true
		}
	default:
		return nil
	}
	return p
}

func clashWSOpts(n Node) map[string]any {
	o := map[string]any{"path": n.Path}
	if n.Host != "" {
		o["headers"] = map[string]any{"Host": n.Host}
	}
	return o
}
```

- [ ] **Step 4: Wire `clash` into `rendererFor`**

In `internal/plugins/subgen/render.go`, add a case before `default`:
```go
	case "clash":
		return &ClashRenderer{}, true
```

- [ ] **Step 5: Run the Clash test**

Run: `go test ./internal/plugins/subgen/ -run TestClash_RendersYAML`
Expected: PASS.

- [ ] **Step 6: Flip the now-valid `clash` target in existing tests + add a success case**

In `internal/plugins/subgen/service_test.go`:
- Change `svc.PreviewTemplate(rules, "clash")` (the `!errors.Is(err, ErrBadTarget)` case) → `svc.PreviewTemplate(rules, "quantumultx")`.
- Change `svc.Generate(context.Background(), "whatever", "clash")` → `svc.Generate(context.Background(), "whatever", "quantumultx")`.
- In `TestService_PreviewTemplate`, after the existing assertions (before the bad-target case), add:
```go
	// clash target now renders YAML
	cy, _, err := svc.PreviewTemplate(rules, "clash")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cy, "proxies:") || !strings.Contains(cy, "MATCH,") {
		t.Fatalf("clash preview:\n%s", cy)
	}
```

In `internal/plugins/subgen/routes_test.go`:
- In `TestRoutes_PreviewTemplate`, change the bad-target body `"target": "clash"` → `"target": "quantumultx"`.
- In `TestRoutes_Preview`, change `preview?target=clash` → `preview?target=quantumultx`.

- [ ] **Step 7: Run the package + gofmt**

Run: `go test ./internal/plugins/subgen/` → expect PASS.
Run: `gofmt -l internal/plugins/subgen/` → expect no output.

- [ ] **Step 8: Commit**

```bash
git add internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_clash_test.go internal/plugins/subgen/render.go internal/plugins/subgen/service_test.go internal/plugins/subgen/routes_test.go
git commit -m "feat(subgen): Clash.Meta YAML renderer + wire clash target"
```

---

## Task 5: Frontend — `clash` target option + `clash_general` editor field

**Files:**
- Modify: `web/src/pages/admin/plugins/subgen/SubscriptionsTab.tsx`, `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`

- [ ] **Step 1: SubscriptionsTab — add clash to the Target type + select**

In `web/src/pages/admin/plugins/subgen/SubscriptionsTab.tsx`:

Change:
```tsx
type Target = 'surge' | 'shadowrocket'
```
to:
```tsx
type Target = 'surge' | 'shadowrocket' | 'clash'
```

Change the per-row target `<select>` options:
```tsx
                        <option value="surge">surge</option>
                        <option value="shadowrocket">shadowrocket</option>
```
to:
```tsx
                        <option value="surge">surge</option>
                        <option value="shadowrocket">shadowrocket</option>
                        <option value="clash">clash</option>
```

- [ ] **Step 2: TemplatesTab — preview target adds clash**

In `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`:

Change:
```tsx
type PreviewTarget = 'surge' | 'shadowrocket'
```
to:
```tsx
type PreviewTarget = 'surge' | 'shadowrocket' | 'clash'
```

Change the preview target `<select>` options:
```tsx
                <option value="surge">surge</option>
                <option value="shadowrocket">shadowrocket</option>
```
to:
```tsx
                <option value="surge">surge</option>
                <option value="shadowrocket">shadowrocket</option>
                <option value="clash">clash</option>
```

- [ ] **Step 3: TemplatesTab — add `clash_general` to the model**

Change the `RulesModel` interface:
```tsx
interface RulesModel {
  categories: CategoryRule[]
  custom_rules: CustomRule[]
  final: string
  include_auto_select: boolean
  general: string
  mitm: string
}
```
to:
```tsx
interface RulesModel {
  categories: CategoryRule[]
  custom_rules: CustomRule[]
  final: string
  include_auto_select: boolean
  general: string
  mitm: string
  clash_general: string
}
```

In `parseRules`, add to the returned object after `mitm: String(raw.mitm ?? ''),`:
```tsx
    clash_general: String(raw.clash_general ?? ''),
```

- [ ] **Step 4: TemplatesTab — editor state, buildModel, switchToForm**

Add state after the `mitm` state line (`const [mitm, setMitm] = useState(initial.mitm)`):
```tsx
  const [clashGeneral, setClashGeneral] = useState(initial.clash_general)
```

In `buildModel`, add after `mitm,`:
```tsx
    clash_general: clashGeneral,
```

In `switchToForm`, add after `setMitm(m.mitm)`:
```tsx
    setClashGeneral(m.clash_general)
```

- [ ] **Step 5: TemplatesTab — add the `[Clash] general` textarea**

Immediately after the `[MITM]` textarea's closing `</div>` (the block whose textarea has `placeholder="hostname = *.googlevideo.com"`), insert:
```tsx
                <div>
                  <Label className="text-[12px]">[Clash] general</Label>
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-1">
                    Raw Clash YAML top-level keys (<code>dns</code>, <code>mode</code>…); used only for the clash target. Leave empty for <code>mode: rule</code>.
                  </p>
                  <textarea
                    value={clashGeneral}
                    onChange={(e) => setClashGeneral(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    className="w-full px-2 py-1.5 rounded-md border bg-background text-[12px] font-mono"
                    placeholder="mode: rule"
                  />
                </div>
```

- [ ] **Step 6: Typecheck + tests**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; vitest all pass. Then `cd /Users/hg/project/Shepherd`.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/admin/plugins/subgen/SubscriptionsTab.tsx web/src/pages/admin/plugins/subgen/TemplatesTab.tsx
git commit -m "feat(subgen): clash target option + clash_general editor field"
```

---

## Task 6: Usage documentation — `docs/subgen.md`

**Files:**
- Create: `docs/subgen.md`

- [ ] **Step 1: Write the guide**

Create `docs/subgen.md` with the following content:

````markdown
# Subscriptions (subgen)

The **Subscriptions** plugin generates client subscription configs from your
existing xray and sing-box inbounds, with category-based routing. Clients poll a
per-subscription URL; you control routing and output format with templates.

## Subscriptions

A subscription bundles a set of inbound nodes + a template + a token. Create one
under **Plugins → Subscriptions**, then:

- **Edit nodes** — pick which xray/sing-box inbounds it exposes.
- **Subscription URL** — `/sub/<token>?target=<format>`. Copy it into your client.
- **Rotate token** — invalidates the old URL and issues a new one.
- **Enabled** — a disabled subscription returns 404.

## Output formats

Set the `target` query parameter:

| `target` | Client | Format |
|----------|--------|--------|
| `surge` | Surge | Surge `.conf` |
| `shadowrocket` | ShadowRocket | Surge `.conf` (ShadowRocket reads it) |
| `clash` | Clash.Meta / mihomo | YAML |

Example: `https://your-host/sub/abcdef…?target=clash`

## Templates

A template describes how traffic is routed. Built-in templates are read-only —
clone one to customize. The editor has a **Form** mode and a **Raw JSON** mode,
plus a live **Preview** pane (pick a target to see the rendered config).

- **Categories** — check a category (Telegram, Streaming, Location:CN, …) to
  route its rule-sets. Each selected category becomes a **switchable proxy
  group** named after it; the **policy** you pick is the group's default member,
  and clients can switch it (e.g. send Telegram via DIRECT). Each category ships
  the blackmatrix7 GitHub rule-set addresses it uses.
- **Custom rules** — one `TYPE,VALUE,policy` per line, e.g.
  `DOMAIN-SUFFIX,example.com,DIRECT` or `IP-CIDR,10.0.0.0/24,PROXY`. These keep
  their explicit policy (no group is generated).
- **Final** — the catch-all policy (Surge `FINAL`, Clash `MATCH`).
- **Include auto-select group** — adds an `Auto Select` url-test group over all
  nodes; the main `PROXY` group lists it first.

## Per-format sections

Different clients have different config sections, so these are kept separate:

- **`[General]`** (Surge / ShadowRocket only) — raw Surge directives, e.g.
  `dns-server = 119.29.29.29, 223.5.5.5`. Empty → default `bypass-system = true`.
- **`[MITM]`** (Surge / ShadowRocket only) — raw Surge MITM directives, e.g.
  `hostname = *.googlevideo.com`. Empty → the section is omitted. Clash has no
  MITM, so this is ignored for the `clash` target.
- **`[Clash] general`** (Clash only) — raw Clash YAML top-level keys, e.g.:
  ```yaml
  mode: rule
  dns:
    enable: true
    nameserver: [223.5.5.5, 119.29.29.29]
  ```
  Empty → default `mode: rule`. This is ignored for the Surge/ShadowRocket
  targets.

## Routing categories

Categories map to remote rule-sets from
[blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script):
Surge targets reference `.../rule/Surge/<Name>/<Name>.list`; the Clash target
defines `rule-providers` pointing at `.../rule/Clash/<Name>/<Name>.yaml`
(`behavior: classical`). `Location:CN` and `Private` use native matchers
(`GEOIP,CN`; Clash maps `Private` to `GEOIP,PRIVATE`).

## Example

A template selecting `Telegram` (PROXY) and `Location:CN` (DIRECT), with
`include_auto_select` on, renders for **Surge**:

```
[Proxy Group]
PROXY = select, Auto Select, <nodes>, DIRECT
Auto Select = url-test, <nodes>, url=http://www.gstatic.com/generate_204, interval=300
Telegram = select, PROXY, DIRECT, REJECT, <nodes>
Location:CN = select, DIRECT, PROXY, REJECT, <nodes>
[Rule]
RULE-SET,https://.../rule/Surge/Telegram/Telegram.list,Telegram
GEOIP,CN,Location:CN
FINAL,PROXY
```

…and for **Clash** (YAML, abridged):

```yaml
proxy-groups:
  - {name: PROXY, type: select, proxies: [Auto Select, <nodes>]}
  - {name: Telegram, type: select, proxies: [PROXY, DIRECT, REJECT, <nodes>]}
rule-providers:
  Telegram: {type: http, behavior: classical, format: yaml, url: 'https://.../rule/Clash/Telegram/Telegram.yaml', path: ./ruleset/Telegram.yaml, interval: 86400}
rules:
  - RULE-SET,Telegram,Telegram
  - GEOIP,CN,Location:CN
  - MATCH,PROXY
```
````

- [ ] **Step 2: Commit**

```bash
git add docs/subgen.md
git commit -m "docs(subgen): usage guide for subscriptions, templates, formats"
```

---

## Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Go build + full test suite**

Run (repo root): `go build ./... && go test ./...`
Expected: build clean; every package `ok` / no failures. `rm -f server` if a stray binary appears.

- [ ] **Step 2: gofmt + go vet**

Run: `gofmt -l internal/plugins/subgen/ && go vet ./internal/plugins/subgen/`
Expected: no gofmt output; vet clean.

- [ ] **Step 3: Frontend gates**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run && cd /Users/hg/project/Shepherd`
Expected: tsc clean; vitest all pass.

- [ ] **Step 4: Confirm clean tree**

Run: `git status --short`
Expected: clean.

---

## Self-Review (completed by plan author)

**Spec coverage:**
- yaml.v3 dep + `clash_general` field + parse validation → Task 1. ✓
- `rulesetURL` + clash dir; keep `ResolveRuleLines` for `/categories` → Task 2. ✓
- Semantic `Intermediate` (`Rule` type), `Assemble(nodes, spec)`, renderer `rulesetBase`, Surge output unchanged → Task 3 (regression assertions incl. the rebuilt `RULE-SET,<surge-url>,Telegram`). ✓
- Clash renderer (proxies/proxy-groups/rule-providers/rules, `MATCH`, preamble, protocol map, `nativeToClash`) + wire target → Task 4. ✓
- Flip the `clash`-as-invalid tests to `quantumultx` + clash success case → Task 4. ✓
- FE clash option (two selects) + `clash_general` field → Task 5. ✓
- `docs/subgen.md` usage guide → Task 6. ✓
- No DB migration; legacy rules_json parses → covered (additive field). ✓

**Placeholder scan:** none — every code step has complete code + exact commands.

**Type/name consistency:** `Rule{Ruleset,Native,Match,Final,Target}`, `Intermediate.ClashGeneral`, `Assemble(nodes, spec)`, `Render(im, subURL, rulesetBase)`, `rulesetURL(folder, target, base)`, `ClashRenderer`/`clashProxy`/`clashWSOpts`/`nativeToClash`, and FE `clash_general`/`clashGeneral` are used consistently across tasks. `Render`'s new 3rd arg is threaded through `service.go`, both renderers, and every `render_*_test.go` call. The `clash` target is added to `rendererFor` (Task 4) only after the invalid-target tests are flipped in the same task.
