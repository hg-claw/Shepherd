# Template Sections + Rule-Derived Proxy Groups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give subgen templates free-text `[General]`/`[MITM]` sections and make each selected rule category render as a client-switchable `select` proxy group, while removing the per-country grouping feature.

**Architecture:** Two new free-text fields on `TemplateSpec` (`General`, `MITM`) flow through `Assemble` onto the `Intermediate`, then the Surge renderer emits them (General replaces the default block; MITM is appended only when non-empty). `Assemble` is reworked so the main `PROXY` group is emitted first, country groups are gone, and every category becomes a `select` group whose rule routes to the group by name. The form editor swaps the "Group by country" toggle for `[General]`/`[MITM]` textareas; raw-JSON mode and live preview need no special handling.

**Tech Stack:** Go (`internal/plugins/subgen`), React/TypeScript (`web/src/pages/admin/plugins/subgen`). Spec: `docs/superpowers/specs/2026-05-26-template-sections-and-rule-derived-groups-design.md`.

**Working directory:** repo root `/Users/hg/project/Shepherd`, branch `feat/subgen-plugin`.

**Conventions to respect (learned the hard way on this plugin):**
- Boolean SQL columns use `true`/`false` literals — not relevant here (no migration), but keep in mind.
- `go build ./...` produces no stray binary; if a subagent runs `go build ./cmd/server`, it must `rm -f server` after.
- `npm run build` deletes `internal/web/dist/.gitkeep`; restore with `git checkout -- internal/web/dist/.gitkeep`. Do NOT run a production `npm run build` during these tasks — `npx tsc --noEmit` + `npx vitest run` are the FE gates.
- Run Go commands from the repo root (a stray `cd web` persists across Bash calls).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `internal/plugins/subgen/template.go` | `TemplateSpec` schema, parse/validate, builtin seed | Add `General`/`MITM`; later remove `GroupByCountry` + its use in `builtinSpec` |
| `internal/plugins/subgen/base.go` | `Intermediate`, `Assemble` (target-agnostic model) | Add `General`/`MITM` to `Intermediate`; rework `Assemble` (PROXY-first, per-category groups, rules→group names, no country groups); add `dedupeStrings` |
| `internal/plugins/subgen/render_surge.go` | Surge/ShadowRocket text rendering | Emit `[General]` from `im.General` or default; append `[MITM]` when set |
| `internal/plugins/subgen/*_test.go` | Unit tests | Update `base_test.go`, add tests in `template_test.go` + `render_surge_test.go`, tidy `service_test.go` |
| `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx` | Template editor (form + raw + preview) | `RulesModel`: drop `group_by_country`, add `general`/`mitm`; swap the toggle for two textareas; update help text |

---

## Task 1: Add `General`/`MITM` to `TemplateSpec`

**Files:**
- Modify: `internal/plugins/subgen/template.go` (the `TemplateSpec` struct, ~lines 22-28)
- Test: `internal/plugins/subgen/template_test.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/plugins/subgen/template_test.go`:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestParseTemplate_GeneralAndMITM`
Expected: FAIL — build error `spec.General undefined (type TemplateSpec has no field or method General)`.

- [ ] **Step 3: Add the fields**

In `internal/plugins/subgen/template.go`, replace the `TemplateSpec` struct:

```go
type TemplateSpec struct {
	Categories        []CategorySel `json:"categories"`
	CustomRules       []CustomRule  `json:"custom_rules"`
	Final             string        `json:"final"`
	GroupByCountry    bool          `json:"group_by_country"`
	IncludeAutoSelect bool          `json:"include_auto_select"`
	General           string        `json:"general,omitempty"` // raw [General] body; empty → renderer default
	MITM              string        `json:"mitm,omitempty"`     // raw [MITM] body; empty → section omitted
}
```

(`GroupByCountry` stays for now — it is removed in Task 4 once nothing reads it. `ParseTemplate` needs no change: `General`/`MITM` are free text and require no validation.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run TestParseTemplate_GeneralAndMITM`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/template.go internal/plugins/subgen/template_test.go
git commit -m "feat(subgen): add free-text General/MITM fields to TemplateSpec"
```

---

## Task 2: Rework `Assemble` — rule-derived groups, no country groups

**Files:**
- Modify: `internal/plugins/subgen/base.go` (full rewrite — small file)
- Test: `internal/plugins/subgen/base_test.go` (replace `TestAssemble_GroupsAndRules`, add helpers)

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `internal/plugins/subgen/base_test.go` with:

```go
package subgen

import (
	"strings"
	"testing"
)

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
	im := Assemble(nodes, spec, "surge", DefaultRulesetBase)

	// PROXY is the first group.
	if len(im.Groups) == 0 || im.Groups[0].Name != "PROXY" {
		t.Fatalf("PROXY not first: %+v", im.Groups)
	}
	// Auto Select present; NO per-country groups.
	if findGroup(im.Groups, "Auto Select") == nil {
		t.Fatal("missing Auto Select group")
	}
	if findGroup(im.Groups, "🇯🇵 JP") != nil || findGroup(im.Groups, "🇸🇬 SG") != nil {
		t.Fatalf("country groups should be gone: %+v", im.Groups)
	}

	// Each category → a select group; first member = configured policy; deduped.
	tg := findGroup(im.Groups, "Telegram")
	if tg == nil || tg.Type != "select" {
		t.Fatalf("Telegram group missing/wrong: %+v", tg)
	}
	wantTG := []string{"PROXY", "DIRECT", "REJECT", "🇯🇵 tokyo vless", "🇸🇬 sg ss"}
	if !equalStrings(tg.Members, wantTG) {
		t.Fatalf("Telegram members = %v want %v", tg.Members, wantTG)
	}
	cn := findGroup(im.Groups, "Location:CN")
	wantCN := []string{"DIRECT", "PROXY", "REJECT", "🇯🇵 tokyo vless", "🇸🇬 sg ss"}
	if cn == nil || !equalStrings(cn.Members, wantCN) {
		t.Fatalf("Location:CN members = %v want %v", cn.Members, wantCN)
	}

	// Custom rule first, FINAL last, category rules route to the GROUP name.
	if im.Rules[0] != "IP-CIDR,10.0.0.0/24,PROXY" {
		t.Fatalf("custom rule not first: %v", im.Rules[0])
	}
	if im.Rules[len(im.Rules)-1] != "FINAL,PROXY" {
		t.Fatalf("final not last: %v", im.Rules[len(im.Rules)-1])
	}
	if !containsRule(im.Rules, "GEOIP,CN,Location:CN") {
		t.Fatalf("CN rule should route to its group: %v", im.Rules)
	}
	foundTG := false
	for _, r := range im.Rules {
		if strings.HasPrefix(r, "RULE-SET,") && strings.HasSuffix(r, ",Telegram") {
			foundTG = true
		}
	}
	if !foundTG {
		t.Fatalf("Telegram rule should route to its group: %v", im.Rules)
	}

	// General/MITM propagate onto the intermediate.
	spec2 := spec
	spec2.General = "dns-server = 1.1.1.1"
	spec2.MITM = "hostname = *.x.com"
	im2 := Assemble(nodes, spec2, "surge", DefaultRulesetBase)
	if im2.General != "dns-server = 1.1.1.1" || im2.MITM != "hostname = *.x.com" {
		t.Fatalf("general/mitm not propagated: %q / %q", im2.General, im2.MITM)
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

func containsRule(rules []string, want string) bool {
	for _, r := range rules {
		if r == want {
			return true
		}
	}
	return false
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestAssemble_GroupsAndRules`
Expected: FAIL — build error (`im.General`/`im2.MITM` undefined on `Intermediate`) and/or assertion failures (country groups still present, `Telegram` group missing).

- [ ] **Step 3: Rewrite `base.go`**

Replace the entire contents of `internal/plugins/subgen/base.go` with:

```go
package subgen

type Group struct {
	Name    string
	Type    string // "select" | "url-test"
	Members []string
}

type Intermediate struct {
	Nodes   []Node
	Groups  []Group
	Rules   []string // FINAL last
	General string   // raw [General] body; empty → renderer default
	MITM    string   // raw [MITM] body; empty → section omitted
}

const autoSelectGroup = "Auto Select"
const mainProxyGroup = "PROXY"

// Assemble builds the target-agnostic model.
//
// Groups, in order: the main "PROXY" select (members = optional "Auto Select"
// then every node name), an "Auto Select" url-test (only if IncludeAutoSelect),
// then one switchable "select" group per category. A category group is named
// after the category; its members are the configured policy (first → the
// default selection), PROXY, DIRECT, REJECT, then every node — de-duplicated.
//
// Rules: custom rules first (verbatim, explicit policy), then one rule per
// category routed to the category's GROUP by name (so clients can re-route it),
// then FINAL. The free-text General/MITM blocks ride along to the renderer.
func Assemble(nodes []Node, spec TemplateSpec, target, rulesetBase string) Intermediate {
	im := Intermediate{Nodes: nodes, General: spec.General, MITM: spec.MITM}

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
		im.Rules = append(im.Rules, r.Match+","+r.Policy)
	}
	for _, c := range spec.Categories {
		// Pass the category name as the rule target so the last field is the
		// group name (RULE-SET,<url>,Telegram / GEOIP,CN,Location:CN).
		im.Rules = append(im.Rules, ResolveRuleLines(c.Name, c.Name, target, rulesetBase)...)
	}
	im.Rules = append(im.Rules, "FINAL,"+spec.Final)
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

(This removes the old `import "sort"` and the `byCountry`/`countryFlag` usage. `countryFlag` remains defined in `node.go` for node naming — do not delete it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run TestAssemble_GroupsAndRules`
Expected: PASS.

- [ ] **Step 5: Run the whole package (catch collateral)**

Run: `go test ./internal/plugins/subgen/`
Expected: PASS. (`service_test.go`'s `🇺🇸`/`🇭🇰` assertions still hold — the flags live in the sample node names, which now also populate the category groups. The `group_by_country` key in its rules string is simply ignored by the new `Assemble`.)

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/subgen/base.go internal/plugins/subgen/base_test.go
git commit -m "feat(subgen): rule-derived select groups; drop country grouping in Assemble"
```

---

## Task 3: Render `[General]` / `[MITM]`

**Files:**
- Modify: `internal/plugins/subgen/render_surge.go` (the `Render` method, ~lines 89-119)
- Test: `internal/plugins/subgen/render_surge_test.go` (add one test)

- [ ] **Step 1: Write the failing test**

Add to `internal/plugins/subgen/render_surge_test.go`:

```go
func TestSurge_GeneralAndMITM(t *testing.T) {
	base := Intermediate{
		Nodes:  []Node{{Name: "n1", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p"}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"n1"}}},
		Rules:  []string{"FINAL,PROXY"},
	}

	// Empty fields: default [General], no [MITM] section.
	out := (&SurgeRenderer{}).Render(base, "https://x/sub/t?target=surge")
	if !strings.Contains(out, "[General]\nbypass-system = true") {
		t.Fatalf("default [General] missing:\n%s", out)
	}
	if strings.Contains(out, "[MITM]") {
		t.Fatalf("[MITM] should be absent when unset:\n%s", out)
	}

	// Set fields: custom [General] replaces default, [MITM] appended.
	im := base
	im.General = "dns-server = 1.1.1.1\nskip-proxy = 10.0.0.0/8"
	im.MITM = "hostname = *.googlevideo.com"
	out = (&SurgeRenderer{}).Render(im, "https://x/sub/t?target=surge")
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestSurge_GeneralAndMITM`
Expected: FAIL — custom `[General]` assertion fails (renderer still emits the hardcoded `bypass-system = true`) and `[MITM]` assertion fails (no section emitted).

- [ ] **Step 3: Implement the renderer change**

In `internal/plugins/subgen/render_surge.go`, in `Render`, replace this line:

```go
	b.WriteString("[General]\nbypass-system = true\n\n")
```

with:

```go
	b.WriteString("[General]\n")
	if g := strings.TrimSpace(im.General); g != "" {
		b.WriteString(g + "\n\n")
	} else {
		b.WriteString("bypass-system = true\n\n")
	}
```

Then change the end of `Render` from:

```go
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(rule + "\n")
	}
	return b.String()
}
```

to:

```go
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(rule + "\n")
	}
	if m := strings.TrimSpace(im.MITM); m != "" {
		b.WriteString("\n[MITM]\n" + m + "\n")
	}
	return b.String()
}
```

(`render_surge.go` already imports `strings`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/ -run 'TestSurge'`
Expected: PASS (new test plus the existing `TestSurge_*` — the existing ones leave `General`/`MITM` empty, so the default `[General]` and absent `[MITM]` keep them green).

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_surge_test.go
git commit -m "feat(subgen): render template [General]/[MITM] sections"
```

---

## Task 4: Remove the `GroupByCountry` field

**Files:**
- Modify: `internal/plugins/subgen/template.go` (`TemplateSpec` struct + `builtinSpec`)
- Modify: `internal/plugins/subgen/service_test.go` (drop the dead key + fix comment)
- Modify: `internal/plugins/subgen/service.go` (fix a stale comment)

- [ ] **Step 1: Remove the field from the struct**

In `internal/plugins/subgen/template.go`, replace the `TemplateSpec` struct so the `GroupByCountry` line is gone:

```go
type TemplateSpec struct {
	Categories        []CategorySel `json:"categories"`
	CustomRules       []CustomRule  `json:"custom_rules"`
	Final             string        `json:"final"`
	IncludeAutoSelect bool          `json:"include_auto_select"`
	General           string        `json:"general,omitempty"` // raw [General] body; empty → renderer default
	MITM              string        `json:"mitm,omitempty"`     // raw [MITM] body; empty → section omitted
}
```

- [ ] **Step 2: Stop setting it in `builtinSpec`**

In `internal/plugins/subgen/template.go`, change:

```go
	t := TemplateSpec{Final: "PROXY", GroupByCountry: true, IncludeAutoSelect: true}
```

to:

```go
	t := TemplateSpec{Final: "PROXY", IncludeAutoSelect: true}
```

- [ ] **Step 3: Tidy `service_test.go`**

In `internal/plugins/subgen/service_test.go`, in `TestService_PreviewTemplate`, change the rules line:

```go
	rules := `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY","group_by_country":true}`
```

to:

```go
	rules := `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`
```

and change the comment:

```go
	// group_by_country yields the two sample-country groups.
```

to:

```go
	// The two sample nodes (🇺🇸 / 🇭🇰) appear in [Proxy] and in each category group.
```

- [ ] **Step 4: Fix the stale comment in `service.go`**

In `internal/plugins/subgen/service.go`, in the `PreviewTemplate` doc comment, change:

```go
// to exercise GroupByCountry. All failures are client-side: ErrBadTarget for an
```

to:

```go
// span two countries so category groups show multiple members. All failures are
```

(Keep the rest of the sentence coherent — the following line currently reads `// unknown target, or a parse error for malformed rulesJSON.` which still fits.)

- [ ] **Step 5: Run the full package + grep for stragglers**

Run: `go build ./... && go test ./internal/plugins/subgen/`
Expected: build clean, tests PASS.

Run: `grep -rn "GroupByCountry\|group_by_country" internal/plugins/subgen/`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/subgen/template.go internal/plugins/subgen/service.go internal/plugins/subgen/service_test.go
git commit -m "refactor(subgen): drop the removed group_by_country field"
```

---

## Task 5: Editor — `[General]`/`[MITM]` textareas, remove country toggle

**Files:**
- Modify: `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`

- [ ] **Step 1: Update the `RulesModel` interface**

Replace:

```tsx
interface RulesModel {
  categories: CategoryRule[]
  custom_rules: CustomRule[]
  final: string
  group_by_country: boolean
  include_auto_select: boolean
}
```

with:

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

- [ ] **Step 2: Update `parseRules`**

Replace the `return { ... }` in `parseRules`:

```tsx
  return {
    categories: Array.isArray(raw.categories)
      ? raw.categories.map((c: any) => ({ name: String(c.name ?? ''), policy: String(c.policy ?? 'PROXY') }))
      : [],
    custom_rules: Array.isArray(raw.custom_rules)
      ? raw.custom_rules.map((c: any) => ({ match: String(c.match ?? ''), policy: String(c.policy ?? 'PROXY') }))
      : [],
    final: String(raw.final ?? 'PROXY'),
    include_auto_select: Boolean(raw.include_auto_select),
    general: String(raw.general ?? ''),
    mitm: String(raw.mitm ?? ''),
  }
```

(The `group_by_country` line is removed; `general`/`mitm` are added.)

- [ ] **Step 3: Update editor state**

In `TemplateEditor`, replace:

```tsx
  const [final, setFinal] = useState<string>(initial.final)
  const [groupByCountry, setGroupByCountry] = useState(initial.group_by_country)
  const [includeAutoSelect, setIncludeAutoSelect] = useState(initial.include_auto_select)
  const [rawJson, setRawJson] = useState('')
```

with:

```tsx
  const [final, setFinal] = useState<string>(initial.final)
  const [includeAutoSelect, setIncludeAutoSelect] = useState(initial.include_auto_select)
  const [general, setGeneral] = useState(initial.general)
  const [mitm, setMitm] = useState(initial.mitm)
  const [rawJson, setRawJson] = useState('')
```

- [ ] **Step 4: Update `buildModel`**

Replace:

```tsx
  const buildModel = (): RulesModel => ({
    categories: Object.entries(catPolicies).map(([name, policy]) => ({ name, policy })),
    custom_rules: textToCustomRules(customText),
    final,
    group_by_country: groupByCountry,
    include_auto_select: includeAutoSelect,
  })
```

with:

```tsx
  const buildModel = (): RulesModel => ({
    categories: Object.entries(catPolicies).map(([name, policy]) => ({ name, policy })),
    custom_rules: textToCustomRules(customText),
    final,
    include_auto_select: includeAutoSelect,
    general,
    mitm,
  })
```

- [ ] **Step 5: Update `switchToForm`**

Replace:

```tsx
    setCustomText(customRulesToText(m.custom_rules))
    setFinal(m.final)
    setGroupByCountry(m.group_by_country)
    setIncludeAutoSelect(m.include_auto_select)
    setMode('form')
```

with:

```tsx
    setCustomText(customRulesToText(m.custom_rules))
    setFinal(m.final)
    setIncludeAutoSelect(m.include_auto_select)
    setGeneral(m.general)
    setMitm(m.mitm)
    setMode('form')
```

- [ ] **Step 6: Update the categories help text**

Replace:

```tsx
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-2">
                    Check a category to route its rule-sets; pick a policy. Rule URLs are the GitHub subscription addresses shipped with each category.
                  </p>
```

with:

```tsx
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-2">
                    Check a category to route its rule-sets. Each becomes a switchable proxy group; the policy you pick is the group's default member (clients can change it). Rule URLs are the GitHub subscription addresses shipped with each category.
                  </p>
```

- [ ] **Step 7: Add the `[General]`/`[MITM]` textareas after the Custom rules block**

Find the Custom rules block (ends with the `<textarea ... placeholder="DOMAIN-SUFFIX,example.com,DIRECT" />` and its closing `</div>`). Immediately after that closing `</div>`, insert:

```tsx
                <div>
                  <Label className="text-[12px]">[General]</Label>
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-1">
                    Raw Surge <code>[General]</code> directives. Leave empty for the default (<code>bypass-system = true</code>).
                  </p>
                  <textarea
                    value={general}
                    onChange={(e) => setGeneral(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    className="w-full px-2 py-1.5 rounded-md border bg-background text-[12px] font-mono"
                    placeholder="dns-server = 119.29.29.29, 223.5.5.5"
                  />
                </div>

                <div>
                  <Label className="text-[12px]">[MITM]</Label>
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-1">
                    Raw Surge <code>[MITM]</code> directives. Leave empty to omit the section.
                  </p>
                  <textarea
                    value={mitm}
                    onChange={(e) => setMitm(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    className="w-full px-2 py-1.5 rounded-md border bg-background text-[12px] font-mono"
                    placeholder="hostname = *.googlevideo.com"
                  />
                </div>
```

- [ ] **Step 8: Remove the "Group by country" checkbox**

In the toggles block, delete this label entirely:

```tsx
                  <label className="flex items-center gap-2 text-[12.5px]">
                    <input type="checkbox" checked={groupByCountry}
                      onChange={(e) => setGroupByCountry(e.target.checked)} />
                    Group by country
                  </label>
```

(Leave the "Include auto-select group" label and the "Final" select in place.)

- [ ] **Step 9: Typecheck + unit tests**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; vitest all pass. (Then `cd` back to repo root for any further commands.)

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/admin/plugins/subgen/TemplatesTab.tsx
git commit -m "feat(subgen): template editor [General]/[MITM] fields; drop country toggle"
```

---

## Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Go build + full test suite**

Run (from repo root): `go build ./... && go test ./...`
Expected: build clean; every package `ok` / no failures. If a stray `server` binary appears, `rm -f server`.

- [ ] **Step 2: Frontend gates**

Run: `cd web && npx tsc --noEmit && npx vitest run && cd ..`
Expected: tsc clean; vitest all pass.

- [ ] **Step 3: Sanity-check the rendered output by hand (optional but recommended)**

Confirm the design's worked example: a template with `Telegram`/`Location:CN`/`Ad Block` categories renders `PROXY` first, a `select` group per category whose first member is the configured policy, category rules whose last field is the group name, default `[General]` when unset, and no `[MITM]` when unset. This is already covered by `TestAssemble_GroupsAndRules` + `TestSurge_GeneralAndMITM`; re-read their output if anything looks off.

- [ ] **Step 4: Confirm clean tree**

Run: `git status --short`
Expected: clean (all changes committed; `internal/web/dist/.gitkeep` intact if any FE build was run).

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Free-text `[General]`/`[MITM]` stored on template → Task 1 (fields) + Task 3 (render). ✓
- Every selected category → switchable `select` group, rule routes to group → Task 2. ✓
- Group members = policy + PROXY + DIRECT + REJECT + all nodes, deduped, policy first → Task 2 (`dedupeStrings`, member order) + test assertions. ✓
- Remove `group_by_country` (field, generation, UI toggle) → Task 2 (generation), Task 4 (field + builtin), Task 5 (toggle). ✓
- PROXY group first → Task 2 (`im.Groups` append order) + test. ✓
- Custom rules keep explicit policy, no group → Task 2 (custom-rule loop unchanged) . ✓
- `[General]` replaces default; `[MITM]` omitted when empty → Task 3 + test. ✓
- Editor textareas + help text; raw/preview unchanged → Task 5. ✓
- No DB migration; legacy rules_json parses → no migration task; Task 1/4 notes. ✓

**Placeholder scan:** none — every code step has complete code and exact commands.

**Type/name consistency:** `Intermediate.General`/`MITM`, `TemplateSpec.General`/`MITM` (Go) and `RulesModel.general`/`mitm` (TS) used consistently; `dedupeStrings`, `mainProxyGroup`, `autoSelectGroup` referenced consistently; `ResolveRuleLines(c.Name, c.Name, target, rulesetBase)` matches its existing 4-arg signature.
