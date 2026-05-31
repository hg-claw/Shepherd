# Subgen Selectable oixCloud Proxy-Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a subgen template selectively include the fixed oixCloud service proxy-groups (deselecting a group drops its group line, its rules, and any orphaned Clash rule-provider), default existing templates to all-selected, and drop `10.0.0.0/8` from the Surge `skip-proxy` line.

**Architecture:** The embedded oixCloud Surge/Clash templates stay the single source of truth. A render-time text filter removes the lines belonging to disabled service groups, keyed on the group **name** (which the templates already encode in `Name = …` group lines, `…,<Group>` rule targets, and `RULE-SET,<provider>,<group>` references). Selection is stored as `disabled_groups` (the *excluded* set, so a zero value means everything is on — existing templates need no migration). Core groups (`Proxy`/`Domestic`/`Others`/`Auto - UrlTest`/`Auto - Smart`) are never selectable.

**Tech Stack:** Go (stdlib `strings`, `net/http`, `gopkg.in/yaml.v3`), React + TypeScript (vitest, @testing-library/react, react-query).

**Spec:** `docs/superpowers/specs/2026-05-30-subgen-oix-selectable-groups-design.md`

---

## File Structure

- `internal/plugins/subgen/oixgroups.go` (new) — group catalog (core vs service) + membership/normalization/disabled-set helpers. Single source for renderer, validation, and the UI endpoint.
- `internal/plugins/subgen/oixgroups_test.go` (new) — catalog/helper tests.
- `internal/plugins/subgen/template.go` — add `TemplateSpec.DisabledGroups` + `ParseTemplate` validation.
- `internal/plugins/subgen/base.go` — add `Intermediate.DisabledGroups`; `Assemble` normalizes it.
- `internal/plugins/subgen/render_surge.go` — `filterSurgeGroups` + wire into `render()` (covers Surge + ShadowRocket).
- `internal/plugins/subgen/render_clash.go` — `filterClashGroups` (+ orphan rule-provider cleanup) + wire into `Render()`.
- `internal/plugins/subgen/templates/oix_surge.tmpl` — remove `,10.0.0.0/8` from `skip-proxy`.
- `internal/plugins/subgen/routes.go` — `GET /oix-groups` handler + registration.
- `web/src/api/subgen.ts` — `listSubgenOixGroups()`.
- `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx` — model + checklist UI.
- `web/src/pages/admin/plugins/subgen/TemplatesTab.logic.test.ts` (new) — pure selection-logic tests.

---

## Task 1: Group catalog + helpers

**Files:**
- Create: `internal/plugins/subgen/oixgroups.go`
- Test: `internal/plugins/subgen/oixgroups_test.go`

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run 'TestOix|TestNormalizeServiceGroups|TestDisabledServiceSet' -v`
Expected: FAIL — `undefined: isOixServiceGroup` (and the other helpers).

- [ ] **Step 3: Write the implementation**

Create `internal/plugins/subgen/oixgroups.go`:

```go
package subgen

// OixCoreGroups are always emitted by the fixed oixCloud templates and are NOT
// user-selectable: they are the main proxy group, the domestic/catch-all groups,
// and the auto-test groups that other groups and the FINAL/MATCH rule reference.
var OixCoreGroups = map[string]bool{
	"Proxy":          true,
	"Domestic":       true,
	"Others":         true,
	"Auto - UrlTest": true,
	"Auto - Smart":   true,
}

// OixServiceGroups is the ordered list of user-selectable service groups in the
// fixed oixCloud templates. Order drives the editor checklist. Keep in sync with
// the [Proxy Group] section of templates/oix_surge.tmpl.
var OixServiceGroups = []string{
	"AdBlock", "AI Suite", "Netflix", "Disney Plus", "YouTube", "Max",
	"Spotify", "CN Mainland TV", "Asian TV", "Global TV", "Apple Push",
	"Apple Services", "Apple TV", "Telegram", "Google FCM", "Crypto",
	"Discord", "PayPal", "Microsoft", "Scholar", "Speedtest", "Steam",
	"TikTok", "miHoYo",
}

// isOixServiceGroup reports whether name is a selectable service group.
func isOixServiceGroup(name string) bool {
	for _, g := range OixServiceGroups {
		if g == name {
			return true
		}
	}
	return false
}

// normalizeServiceGroups drops any name that is not a selectable service group
// (core names, stale names), preserving input order. Defensive: a bad name can
// never strip an unintended part of the template.
func normalizeServiceGroups(names []string) []string {
	var out []string
	for _, n := range names {
		if isOixServiceGroup(n) {
			out = append(out, n)
		}
	}
	return out
}

// disabledServiceSet builds a name→true lookup of disabled service groups,
// ignoring non-service names.
func disabledServiceSet(names []string) map[string]bool {
	out := make(map[string]bool, len(names))
	for _, n := range names {
		if isOixServiceGroup(n) {
			out[n] = true
		}
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run 'TestOix|TestNormalizeServiceGroups|TestDisabledServiceSet' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/oixgroups.go internal/plugins/subgen/oixgroups_test.go
git commit -m "feat(subgen): oixCloud group catalog (core vs selectable service groups)"
```

---

## Task 2: `disabled_groups` on TemplateSpec + validation

**Files:**
- Modify: `internal/plugins/subgen/template.go` (struct `TemplateSpec` ~line 29; `ParseTemplate` ~line 51)
- Test: `internal/plugins/subgen/template_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/subgen/template_test.go`:

```go
func TestParseTemplate_DisabledGroups(t *testing.T) {
	if _, err := ParseTemplate(`{"disabled_groups":["Netflix"]}`); err != nil {
		t.Fatalf("valid service group rejected: %v", err)
	}
	if _, err := ParseTemplate(`{"disabled_groups":["Nope"]}`); err == nil {
		t.Fatalf("unknown group must be rejected")
	}
	if _, err := ParseTemplate(`{"disabled_groups":["Proxy"]}`); err == nil {
		t.Fatalf("core group must be rejected as a disabled service group")
	}
	// Legacy template (no disabled_groups key) ⇒ all groups on (empty slice).
	sp, err := ParseTemplate(`{"final":"PROXY"}`)
	if err != nil {
		t.Fatalf("legacy parse failed: %v", err)
	}
	if len(sp.DisabledGroups) != 0 {
		t.Fatalf("legacy default must be all-on, got %v", sp.DisabledGroups)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestParseTemplate_DisabledGroups -v`
Expected: FAIL — `sp.DisabledGroups undefined` (field missing).

- [ ] **Step 3: Add the field**

In `internal/plugins/subgen/template.go`, add to the `TemplateSpec` struct (after `CustomGroups`):

```go
	CustomGroups      []CustomGroup `json:"custom_groups,omitempty"`
	DisabledGroups    []string      `json:"disabled_groups,omitempty"` // excluded service groups; empty = all on
```

- [ ] **Step 4: Add validation in `ParseTemplate`**

In `internal/plugins/subgen/template.go`, inside `ParseTemplate`, after the existing `for _, g := range t.CustomGroups { … }` loop and before `return t, nil`, insert:

```go
	for _, g := range t.DisabledGroups {
		if !isOixServiceGroup(g) {
			return t, fmt.Errorf("unknown service group %q in disabled_groups", g)
		}
	}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run TestParseTemplate_DisabledGroups -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/subgen/template.go internal/plugins/subgen/template_test.go
git commit -m "feat(subgen): add disabled_groups to TemplateSpec with validation"
```

---

## Task 3: Carry `DisabledGroups` through `Intermediate` / `Assemble`

**Files:**
- Modify: `internal/plugins/subgen/base.go` (`Intermediate` struct; `Assemble`)
- Test: `internal/plugins/subgen/base_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/subgen/base_test.go`:

```go
func TestAssemble_NormalizesDisabledGroups(t *testing.T) {
	im := Assemble(nil, TemplateSpec{DisabledGroups: []string{"Netflix", "Bogus", "Proxy"}})
	if len(im.DisabledGroups) != 1 || im.DisabledGroups[0] != "Netflix" {
		t.Fatalf("want [Netflix], got %v", im.DisabledGroups)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestAssemble_NormalizesDisabledGroups -v`
Expected: FAIL — `im.DisabledGroups undefined`.

- [ ] **Step 3: Add the field + populate it**

In `internal/plugins/subgen/base.go`, add to the `Intermediate` struct (after `ClashGeneral`):

```go
	ClashGeneral string // Clash YAML preamble; empty → {mode: rule}
	DisabledGroups []string // excluded oixCloud service groups (normalized)
```

In `Assemble`, set it on the `im` literal (after `ClashGeneral: spec.ClashGeneral,`):

```go
		ClashGeneral: spec.ClashGeneral,
		DisabledGroups: normalizeServiceGroups(spec.DisabledGroups),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run TestAssemble_NormalizesDisabledGroups -v`
Expected: PASS. Then `gofmt -w internal/plugins/subgen/base.go` to align the struct fields.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/base.go internal/plugins/subgen/base_test.go
git commit -m "feat(subgen): thread DisabledGroups through Intermediate/Assemble"
```

---

## Task 4: Surge group/rule filter

**Files:**
- Modify: `internal/plugins/subgen/render_surge.go` (`render()` ~line 158; add helpers)
- Test: `internal/plugins/subgen/render_surge_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/subgen/render_surge_test.go`:

```go
func TestSurge_DisabledGroupsDropped(t *testing.T) {
	im := Intermediate{
		Nodes:          []Node{{Name: "🟢 A", Protocol: "shadowsocks", Server: "1.1.1.1", Port: 8388, SSMethod: "aes-256-gcm", Password: "p"}},
		DisabledGroups: []string{"Netflix", "AdBlock"},
	}
	out := (&SurgeRenderer{}).Render(im, "https://sub", DefaultRulesetBase)
	if strings.Contains(out, "\nNetflix = select") || strings.Contains(out, "\nAdBlock = select") {
		t.Errorf("disabled group line still present\n%s", out)
	}
	if strings.Contains(out, "/Media/Netflix.list,Netflix") || strings.Contains(out, "/AdBlock.list,AdBlock") {
		t.Errorf("disabled group rule still present\n%s", out)
	}
	if !strings.Contains(out, "\nProxy = select") || !strings.Contains(out, "\nOthers = select") {
		t.Errorf("core group wrongly dropped\n%s", out)
	}
	if !strings.Contains(out, "GEOIP,CN,Domestic") || !strings.Contains(out, "FINAL,Others") {
		t.Errorf("structural rule wrongly dropped\n%s", out)
	}
	if !strings.Contains(out, "\nYouTube = select") {
		t.Errorf("non-disabled service group wrongly dropped\n%s", out)
	}
	if strings.Contains(out, "{{") {
		t.Errorf("unresolved marker\n%s", out)
	}
}

func TestSurge_NoDisabledIsParity(t *testing.T) {
	full := (&SurgeRenderer{}).Render(Intermediate{}, "x", DefaultRulesetBase)
	got := (&SurgeRenderer{}).Render(Intermediate{DisabledGroups: []string{}}, "x", DefaultRulesetBase)
	if got != full {
		t.Fatalf("empty disabled set changed Surge output")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run 'TestSurge_DisabledGroupsDropped|TestSurge_NoDisabledIsParity' -v`
Expected: FAIL — disabled group lines still present (filter not wired yet).

- [ ] **Step 3: Add the filter helpers**

Append to `internal/plugins/subgen/render_surge.go`:

```go
// filterSurgeGroups removes the [Proxy Group] lines and [Rule] lines belonging to
// any disabled service group, leaving all other sections untouched. The link is
// the group name: a proxy-group line is "<Name> = ..."; a rule routes to the
// field before ",extended-matching" (RULE-SET) or its last comma field. An empty
// disabled set returns the template unchanged.
func filterSurgeGroups(tmpl string, disabled map[string]bool) string {
	if len(disabled) == 0 {
		return tmpl
	}
	lines := strings.Split(tmpl, "\n")
	out := make([]string, 0, len(lines))
	section := ""
	for _, line := range lines {
		if strings.HasPrefix(line, "[") && strings.HasSuffix(strings.TrimRight(line, " "), "]") {
			section = strings.TrimSpace(line)
		}
		switch section {
		case "[Proxy Group]":
			if name, ok := surgeGroupName(line); ok && disabled[name] {
				continue
			}
		case "[Rule]":
			if disabled[surgeRuleTarget(line)] {
				continue
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// surgeGroupName returns the left-hand name of a "<Name> = ..." proxy-group line.
func surgeGroupName(line string) (string, bool) {
	i := strings.Index(line, " = ")
	if i <= 0 {
		return "", false
	}
	return strings.TrimSpace(line[:i]), true
}

// surgeRuleTarget returns the policy/group a Surge [Rule] line routes to, or ""
// for blank/marker lines.
func surgeRuleTarget(line string) string {
	fields := strings.Split(line, ",")
	if len(fields) < 2 {
		return ""
	}
	t := strings.TrimSpace(fields[len(fields)-1])
	if t == "extended-matching" {
		t = strings.TrimSpace(fields[len(fields)-2])
	}
	return t
}
```

- [ ] **Step 4: Wire the filter into `render()`**

In `internal/plugins/subgen/render_surge.go`, change line 158 from:

```go
	out := templates.Surge
```

to:

```go
	out := filterSurgeGroups(templates.Surge, disabledServiceSet(im.DisabledGroups))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/ -run 'TestSurge' -v`
Expected: PASS (new tests + all existing Surge tests).

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_surge_test.go
git commit -m "feat(subgen): filter disabled service groups from Surge output"
```

---

## Task 5: Clash group/rule/rule-provider filter

**Files:**
- Modify: `internal/plugins/subgen/render_clash.go` (`Render()` ~line 102; add helpers)
- Test: `internal/plugins/subgen/render_clash_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/subgen/render_clash_test.go`:

```go
func TestClash_DisabledGroupsDropped(t *testing.T) {
	im := Intermediate{DisabledGroups: []string{"Asian TV"}}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "name: 'Asian TV'") {
		t.Errorf("disabled proxy-group still present\n%s", out)
	}
	if strings.Contains(out, ",Asian TV'") {
		t.Errorf("rule targeting disabled group still present\n%s", out)
	}
	// Providers that were unique to Asian TV become orphaned and must be removed.
	if strings.Contains(out, "Abema TV") || strings.Contains(out, "Bahamut") {
		t.Errorf("orphaned rule-provider still present\n%s", out)
	}
	// Core groups + core-referenced providers survive.
	if !strings.Contains(out, "name: Proxy") || !strings.Contains(out, "Domestic:") {
		t.Errorf("core group/provider wrongly dropped\n%s", out)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not valid YAML after filtering: %v\n%s", err, out)
	}
}

func TestClash_NoDisabledIsParity(t *testing.T) {
	full := (&ClashRenderer{}).Render(Intermediate{}, "", DefaultRulesetBase)
	got := (&ClashRenderer{}).Render(Intermediate{DisabledGroups: []string{}}, "", DefaultRulesetBase)
	if got != full {
		t.Fatalf("empty disabled set changed Clash output")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run 'TestClash_DisabledGroupsDropped|TestClash_NoDisabledIsParity' -v`
Expected: FAIL — `Asian TV` group/rules/providers still present.

- [ ] **Step 3: Add the filter helpers**

Append to `internal/plugins/subgen/render_clash.go`:

```go
// filterClashGroups removes the proxy-group, rule, and rule-provider entries of
// any disabled service group from the fixed Clash template while keeping it valid
// YAML. A rule-provider is dropped only if it was referenced before filtering AND
// is no longer referenced after — so an empty disabled set returns the template
// byte-for-byte unchanged, and providers never referenced by a rule are left
// alone. proxy-groups precede rules precede rule-providers in the template, so a
// single forward pass has the full surviving-reference set ready by the time the
// rule-providers block is reached.
func filterClashGroups(tmpl string, disabled map[string]bool) string {
	if len(disabled) == 0 {
		return tmpl
	}
	lines := strings.Split(tmpl, "\n")

	// References that exist before any filtering (RULE-SET,<provider>,<group>).
	refBefore := map[string]bool{}
	for _, line := range lines {
		if p, _, ok := clashRuleRef(line); ok {
			refBefore[p] = true
		}
	}

	out := make([]string, 0, len(lines))
	refAfter := map[string]bool{}
	section := ""
	for _, line := range lines {
		if h, ok := clashTopKey(line); ok {
			section = h
			out = append(out, line)
			continue
		}
		switch section {
		case "proxy-groups":
			if name, ok := clashGroupName(line); ok && disabled[name] {
				continue
			}
		case "rules":
			if p, g, ok := clashRuleRef(line); ok {
				if disabled[g] {
					continue
				}
				refAfter[p] = true
			} else if g, ok := clashRuleTarget(line); ok && disabled[g] {
				continue
			}
		case "rule-providers":
			if key, ok := clashProviderKey(line); ok && refBefore[key] && !refAfter[key] {
				continue
			}
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// clashTopKey reports whether line is a top-level (column-0) YAML construct, and
// returns the key name (without trailing ":") so the caller can track sections.
// Any column-0 line resets the section so indented entries below an untracked key
// are never filtered.
func clashTopKey(line string) (string, bool) {
	if line == "" || line[0] == ' ' || line[0] == '\t' || line[0] == '#' {
		return "", false
	}
	if i := strings.Index(line, ":"); i > 0 {
		return line[:i], true
	}
	return "_", true // e.g. a "{{CLASH_EXTRA}}" marker — still resets section
}

// clashGroupName extracts the name of a "- { name: <G>, ... }" proxy-group item.
func clashGroupName(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "- {") {
		return "", false
	}
	i := strings.Index(t, "name:")
	if i < 0 {
		return "", false
	}
	rest := t[i+len("name:"):]
	if j := strings.Index(rest, ","); j >= 0 {
		rest = rest[:j]
	}
	return strings.Trim(strings.TrimSpace(rest), "'"), true
}

// clashRuleBody returns the unquoted payload of a "    - '<payload>'" rule item,
// or ("", false) for non-rule lines (blank, marker, section header).
func clashRuleBody(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if !strings.HasPrefix(t, "- ") {
		return "", false
	}
	t = strings.Trim(strings.TrimSpace(strings.TrimPrefix(t, "- ")), "'")
	if t == "" || strings.HasPrefix(t, "{{") {
		return "", false
	}
	return t, true
}

// clashRuleRef returns (provider, group, true) for a "RULE-SET,<provider>,<group>"
// rule, else ("", "", false).
func clashRuleRef(line string) (provider, group string, ok bool) {
	body, ok := clashRuleBody(line)
	if !ok {
		return "", "", false
	}
	fields := strings.Split(body, ",")
	if len(fields) >= 3 && strings.EqualFold(strings.TrimSpace(fields[0]), "RULE-SET") {
		return strings.TrimSpace(fields[1]), strings.TrimSpace(fields[len(fields)-1]), true
	}
	return "", "", false
}

// clashRuleTarget returns the policy a non-RULE-SET rule routes to (last field).
func clashRuleTarget(line string) (string, bool) {
	body, ok := clashRuleBody(line)
	if !ok {
		return "", false
	}
	fields := strings.Split(body, ",")
	if len(fields) < 2 {
		return "", false
	}
	return strings.TrimSpace(fields[len(fields)-1]), true
}

// clashProviderKey returns the YAML key of a "    <Key>: { ... }" rule-provider
// line, unquoting it; ("", false) for markers/comments/blank lines.
func clashProviderKey(line string) (string, bool) {
	t := strings.TrimSpace(line)
	if t == "" || strings.HasPrefix(t, "{{") || strings.HasPrefix(t, "#") {
		return "", false
	}
	i := strings.Index(t, ":")
	if i <= 0 {
		return "", false
	}
	return strings.Trim(strings.TrimSpace(t[:i]), "'"), true
}
```

- [ ] **Step 4: Wire the filter into `Render()`**

In `internal/plugins/subgen/render_clash.go`, change line 102 from:

```go
	out := templates.Clash
```

to:

```go
	out := filterClashGroups(templates.Clash, disabledServiceSet(im.DisabledGroups))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/ -run 'TestClash' -v`
Expected: PASS (new tests + all existing Clash tests, incl. `TestClash_DeterministicProviders`).

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_clash_test.go
git commit -m "feat(subgen): filter disabled service groups + orphan providers from Clash output"
```

---

## Task 6: Drop `10.0.0.0/8` from Surge `skip-proxy`

**Files:**
- Modify: `internal/plugins/subgen/templates/oix_surge.tmpl` (line 6, `skip-proxy = …`)
- Test: `internal/plugins/subgen/render_surge_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/subgen/render_surge_test.go`:

```go
func TestSurge_SkipProxyDrops10Net(t *testing.T) {
	out := (&SurgeRenderer{}).Render(Intermediate{}, "https://sub", DefaultRulesetBase)
	if strings.Contains(out, "10.0.0.0/8") {
		t.Fatalf("skip-proxy must not contain 10.0.0.0/8\n%s", out)
	}
	// neighbouring private ranges must remain
	if !strings.Contains(out, "172.16.0.0/12") || !strings.Contains(out, "192.168.0.0/16") {
		t.Fatalf("skip-proxy lost other private ranges\n%s", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestSurge_SkipProxyDrops10Net -v`
Expected: FAIL — `10.0.0.0/8` still present.

- [ ] **Step 3: Edit the template**

In `internal/plugins/subgen/templates/oix_surge.tmpl` line 6, remove the substring `10.0.0.0/8,` so `...,mobile-bank.psbc.com,10.0.0.0/8,100.64.0.0/10,...` becomes `...,mobile-bank.psbc.com,100.64.0.0/10,...`. (Delete exactly `10.0.0.0/8,` — one token plus its trailing comma; leave every other entry intact.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/ -run TestSurge -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/templates/oix_surge.tmpl internal/plugins/subgen/render_surge_test.go
git commit -m "fix(subgen): drop 10.0.0.0/8 from Surge skip-proxy"
```

---

## Task 7: `GET /oix-groups` endpoint

**Files:**
- Modify: `internal/plugins/subgen/routes.go` (registration ~line 38; handler near `listCategories` ~line 409)
- Test: `internal/plugins/subgen/routes_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/subgen/routes_test.go` (add imports `encoding/json`, `net/http/httptest` if not already present in that file):

```go
func TestListOixGroups(t *testing.T) {
	p := &Plugin{}
	w := httptest.NewRecorder()
	p.listOixGroups(w, httptest.NewRequest("GET", "/oix-groups", nil))
	if w.Code != 200 {
		t.Fatalf("status = %d", w.Code)
	}
	var got []string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if len(got) != len(OixServiceGroups) || got[0] != "AdBlock" {
		t.Fatalf("got %v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestListOixGroups -v`
Expected: FAIL — `p.listOixGroups undefined`.

- [ ] **Step 3: Add the handler + register it**

In `internal/plugins/subgen/routes.go`, add the handler next to `listCategories`:

```go
// listOixGroups returns the ordered list of user-selectable oixCloud service
// groups, so the template editor renders its checklist from the same source the
// renderer filters on.
func (p *Plugin) listOixGroups(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, 200, OixServiceGroups)
}
```

Register it next to the `GET /categories` line (~line 38):

```go
	mux.HandleFunc("GET /categories", p.listCategories)
	mux.HandleFunc("GET /oix-groups", p.listOixGroups)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run TestListOixGroups -v`
Expected: PASS.

- [ ] **Step 5: Full backend gates**

Run: `gofmt -l internal/plugins/subgen/ && go test -race ./internal/plugins/subgen/... && golangci-lint run ./internal/plugins/subgen/...`
Expected: `gofmt -l` prints nothing; tests PASS; linter clean.

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/subgen/routes.go internal/plugins/subgen/routes_test.go
git commit -m "feat(subgen): GET /oix-groups endpoint for the editor checklist"
```

---

## Task 8: Frontend API — `listSubgenOixGroups`

**Files:**
- Modify: `web/src/api/subgen.ts` (after `listSubgenCategories` ~line 97)

- [ ] **Step 1: Add the API call**

In `web/src/api/subgen.ts`, after the `listSubgenCategories` export, add:

```ts
// listSubgenOixGroups returns the ordered selectable oixCloud service-group names.
export const listSubgenOixGroups = (): Promise<string[]> =>
  api.get<string[]>(`${BASE}/oix-groups`)
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/api/subgen.ts
git commit -m "feat(subgen-ui): listSubgenOixGroups api call"
```

---

## Task 9: Frontend model — `disabled_groups` + selection logic

**Files:**
- Modify: `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx` (`RulesModel` ~line 34; `parseRules` ~line 47; `buildModel` ~line 258)
- Test: `web/src/pages/admin/plugins/subgen/TemplatesTab.logic.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/admin/plugins/subgen/TemplatesTab.logic.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { parseRules, selectedToDisabled } from './TemplatesTab'

describe('subgen template selection logic', () => {
  it('defaults disabled_groups to [] when the key is absent (legacy → all checked)', () => {
    expect(parseRules('{"final":"PROXY"}').disabled_groups).toEqual([])
  })

  it('reads disabled_groups when present', () => {
    expect(parseRules('{"disabled_groups":["Netflix","Steam"]}').disabled_groups)
      .toEqual(['Netflix', 'Steam'])
  })

  it('selectedToDisabled returns catalog members not in the checked set, in order', () => {
    const all = ['AdBlock', 'Netflix', 'YouTube', 'Steam']
    const checked = new Set(['AdBlock', 'YouTube'])
    expect(selectedToDisabled(all, checked)).toEqual(['Netflix', 'Steam'])
  })

  it('selectedToDisabled returns [] when everything is checked', () => {
    const all = ['AdBlock', 'Netflix']
    expect(selectedToDisabled(all, new Set(all))).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/admin/plugins/subgen/TemplatesTab.logic.test.ts`
Expected: FAIL — `parseRules`/`selectedToDisabled` are not exported.

- [ ] **Step 3: Add `disabled_groups` to the model + export the helpers**

In `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`:

a) Add to the `RulesModel` interface (after `custom_groups`):

```ts
  custom_groups: CustomGroupModel[]
  disabled_groups: string[]
```

b) Change `function parseRules(...)` to `export function parseRules(...)`, and add the field to its returned object (after the `custom_groups:` mapping):

```ts
    disabled_groups: Array.isArray(raw.disabled_groups)
      ? raw.disabled_groups.map(String)
      : [],
```

c) Add the field to the object `buildModel` returns (after `custom_groups: textToCustomGroups(customGroupsText),`):

```ts
    disabled_groups: selectedToDisabled(oixGroups, checkedGroups),
```

(`oixGroups` and `checkedGroups` are introduced in Task 10; defining the helper now is harmless because `buildModel` is only called from the component once that state exists.)

d) Add the exported pure helper near the other top-level helpers (e.g. after `parseRules`):

```ts
// selectedToDisabled returns the catalog groups that are NOT checked, preserving
// catalog order — this is what gets persisted as disabled_groups.
export function selectedToDisabled(allGroups: string[], checked: Set<string>): string[] {
  return allGroups.filter((g) => !checked.has(g))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/pages/admin/plugins/subgen/TemplatesTab.logic.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/subgen/TemplatesTab.tsx web/src/pages/admin/plugins/subgen/TemplatesTab.logic.test.ts
git commit -m "feat(subgen-ui): disabled_groups model + selection helpers"
```

---

## Task 10: Frontend UI — service-group checklist

**Files:**
- Modify: `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx` (imports; editor state ~line 232; the `Categories` block ~lines 355-396)

- [ ] **Step 1: Import the API call + add the query/state**

In `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`:

a) Add `listSubgenOixGroups` to the existing `@/api/subgen` import block (alongside `listSubgenCategories`).

b) In the editor component (where `initial` is in scope — the form component that already has `catPolicies` state ~line 232), add:

```ts
  const oixGroupsQ = useQuery({ queryKey: ['subgen-oix-groups'], queryFn: listSubgenOixGroups })
  const oixGroups = oixGroupsQ.data ?? []
  // A group is checked iff it is NOT in the template's disabled_groups.
  const [checkedGroups, setCheckedGroups] = useState<Set<string>>(
    () => new Set<string>(), // reconciled against the catalog once it loads (effect below)
  )
```

c) Reconcile the checked set whenever the catalog or the loaded template changes — checked = catalog − disabled_groups:

```ts
  useEffect(() => {
    const disabled = new Set(initial.disabled_groups)
    setCheckedGroups(new Set(oixGroups.filter((g) => !disabled.has(g))))
  }, [oixGroups, initial.disabled_groups])
```

(If `useEffect`/`useState` are not yet imported from `react`, add them. `initial.disabled_groups` is stable per the editor instance.)

d) Add toggle + bulk helpers:

```ts
  const toggleGroup = (name: string) =>
    setCheckedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  const checkAllGroups = () => setCheckedGroups(new Set(oixGroups))
  const clearAllGroups = () => setCheckedGroups(new Set())
```

- [ ] **Step 2: Replace the `Categories` block with the checklist**

Replace the entire `<div>` that renders the `Categories` label and `categories.map(...)` (the block from `<Label className="text-[12px]">Categories</Label>` through its closing `</div>` before `Custom rules`, ~lines 355-396) with:

```tsx
                <div>
                  <div className="flex items-center gap-2">
                    <Label className="text-[12px]">Proxy groups</Label>
                    <button type="button" onClick={checkAllGroups}
                      className="ml-auto text-[11px] text-fg-dim hover:text-fg underline">Select all</button>
                    <button type="button" onClick={clearAllGroups}
                      className="text-[11px] text-fg-dim hover:text-fg underline">Clear</button>
                  </div>
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-2">
                    Checked service groups (and their rules) are included in the generated config. Core groups (Proxy / Domestic / Others / Auto) are always present.
                  </p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {oixGroups.map((name) => (
                      <label key={name} className="flex items-center gap-2 text-[12.5px] rounded-md border bg-sunken/30 px-2 py-1">
                        <input type="checkbox" checked={checkedGroups.has(name)}
                          onChange={() => toggleGroup(name)} aria-label={`group ${name}`} />
                        <span className="font-mono">{name}</span>
                      </label>
                    ))}
                    {oixGroups.length === 0 && (
                      <div className="text-fg-dim text-[12px]">No groups defined.</div>
                    )}
                  </div>
                </div>
```

- [ ] **Step 3: Remove now-dead category state/handlers**

The old `categories` prop, `catPolicies`/`setCatPolicies`, `toggleCat`, `setCatPolicy`, `listSubgenCategories` query, and the `categories` field in `buildModel` are no longer used by the UI. Remove them, and set `buildModel`'s `categories` to `[]` (the backend keeps the legacy field optional):

```ts
    categories: [],
```

Then delete the unused `catQ`/`categories`/`catPolicies`/`toggleCat`/`setCatPolicy`/`POLICIES` references and the `SubgenCategory`/`listSubgenCategories` imports **only if** nothing else references them (grep first; the `CategoryRule` type and `parseRules`' `categories` mapping can stay since stored templates may still carry the field).

- [ ] **Step 4: Type-check + run all frontend tests**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: no type errors (remove any leftover unused symbols tsc flags); all tests PASS.

- [ ] **Step 5: Manual visual check**

Run the app, open Admin → Plugins → Subgen → Templates → edit a template. Confirm: the checklist shows all 24 service groups; an existing template loads with everything checked; unchecking a group then saving and re-opening keeps it unchecked; the live preview drops the unchecked group's proxy-group + rules.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/subgen/TemplatesTab.tsx
git commit -m "feat(subgen-ui): selectable proxy-group checklist (default all on)"
```

---

## Task 11: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full backend gates**

Run: `gofmt -l ./internal/... && go test -race ./internal/plugins/subgen/... && golangci-lint run ./internal/plugins/subgen/...`
Expected: no gofmt output, tests PASS, linter clean.

- [ ] **Step 2: Full frontend gates**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: clean.

- [ ] **Step 3: Cross-format spot check**

Add a short throwaway test (or use the preview UI) generating a Surge **and** a Clash config with `DisabledGroups: ["Netflix","Asian TV"]`. Confirm in both: the `Netflix`/`Asian TV` proxy-groups and their rules are gone; the Surge output has no `Netflix.list,Netflix` rule; the Clash output drops the orphaned `Abema TV`/`Bahamut`/… providers and still parses via `yaml.Unmarshal`; the `Proxy`/`Others`/`Domestic` groups and `FINAL,Others`/`MATCH,Others` catch-alls remain. Delete the throwaway test before finishing.

---

## Self-Review

- **Spec coverage:** skip-proxy → Task 6. Selectable service groups (drop group+rules) → Surge Task 4, Clash Task 5. Orphan provider cleanup → Task 5. Core-always → Task 1 catalog (core never in `OixServiceGroups`) + filters only act on disabled service names. Existing templates default all-on → Task 2 (absent key → empty) + Task 9 (parseRules → `[]`) + Task 10 (effect: checked = catalog − disabled). Catalog/endpoint → Tasks 1/7/8. UI checklist + select-all/clear → Task 10. ShadowRocket parity → Task 4 wires the filter in the shared `render()` (covered by `render_shadowrocket_test.go` running green in Task 5/7 gates). Data model `disabled_groups` → Tasks 2/3/9. All spec sections map to a task.
- **Type consistency:** `DisabledGroups []string` is identical on `TemplateSpec` (Task 2) and `Intermediate` (Task 3); `disabledServiceSet`/`normalizeServiceGroups`/`isOixServiceGroup` defined in Task 1 are used unchanged in Tasks 2-5; frontend `disabled_groups: string[]` and `selectedToDisabled(allGroups, checked)` match between Tasks 9 and 10.
- **Placeholders:** none — every code step shows complete code; verification steps give exact commands and expected output.
