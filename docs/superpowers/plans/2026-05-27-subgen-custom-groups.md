# Custom Proxy Groups (+ Ponte/DEVICE) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a template define named proxy groups `{name, type, members[]}` (rendered verbatim, no auto-DIRECT), with `DEVICE:` (Surge Ponte) members/rules kept only for Surge and filtered out of Clash + ShadowRocket.

**Architecture:** `TemplateSpec.CustomGroups` (in rules_json) → `Assemble` appends each as a `Group{Verbatim:true}` after Auto Select, before category groups. The shared Surge/ShadowRocket `render` flavor flag becomes `target string`; Surge keeps `DEVICE:`, ShadowRocket + Clash filter it (via a shared `dropDevicePolicies` helper) from group members and `DEVICE:`-policy rules. Routing reuses existing custom rules / category policies pointing at a group name.

**Tech Stack:** Go (`internal/plugins/subgen`), React/TS (`TemplatesTab.tsx`). Spec: `docs/superpowers/specs/2026-05-27-subgen-custom-groups-design.md`.

**Working directory:** repo root `/Users/hg/project/Shepherd`, branch `feat/subgen-ai-ruleset` (this work accumulates here with the AI-ruleset change).

**Conventions:** Run Go from repo root. `go build ./...` leaves no binary (`rm -f server`). FE gates: `npx tsc --noEmit` + `npx vitest run` from `web/` (do NOT `npm run build`). gofmt-clean every file.

---

## File Structure

| File | Change |
|------|--------|
| `internal/plugins/subgen/template.go` | `CustomGroup` type + `TemplateSpec.CustomGroups` + `ParseTemplate` validation |
| `internal/plugins/subgen/base.go` | `Group.Verbatim` + `Assemble` appends custom groups |
| `internal/plugins/subgen/render.go` | shared `dropDevicePolicies` helper (+ `strings` import) |
| `internal/plugins/subgen/render_surge.go` | `render` flavor `wgInline bool`→`target string`; `groupLine` honors `Verbatim`; filter `DEVICE:` members/rules for non-surge |
| `internal/plugins/subgen/render_shadowrocket.go` | `Render` passes `"shadowrocket"` |
| `internal/plugins/subgen/render_clash.go` | filter `DEVICE:` from group members + `DEVICE:` rules |
| `internal/plugins/subgen/*_test.go` | template/base/surge/shadowrocket/clash tests |
| `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx` | `custom_groups` editor field (textarea ↔ struct) |
| `docs/subgen.md` | custom-groups + Ponte/DEVICE note |

---

## Task 1: `TemplateSpec.CustomGroups` + validation

**Files:**
- Modify: `internal/plugins/subgen/template.go`
- Test: `internal/plugins/subgen/template_test.go`

- [ ] **Step 1: Write the failing test** — append to `internal/plugins/subgen/template_test.go`:

```go
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
```

- [ ] **Step 2: Run, expect FAIL** — `go test ./internal/plugins/subgen/ -run TestParseTemplate_CustomGroups` (build error: `spec.CustomGroups` / `CustomGroup` undefined).

- [ ] **Step 3: Add the type, field, and validation** — In `internal/plugins/subgen/template.go`:

(a) Add the `CustomGroup` type near `CustomRule`:
```go
type CustomGroup struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`    // select | url-test
	Members []string `json:"members"`
}
```

(b) Add the field to `TemplateSpec` (after `CustomNodes`):
```go
	CustomGroups []CustomGroup `json:"custom_groups,omitempty"`
```

(c) In `ParseTemplate`, before the final `return t, nil`, add:
```go
	for _, g := range t.CustomGroups {
		if g.Name == "" {
			return t, fmt.Errorf("custom group: empty name")
		}
		if g.Type != "select" && g.Type != "url-test" {
			return t, fmt.Errorf("custom group %q: bad type %q (want select|url-test)", g.Name, g.Type)
		}
		if len(g.Members) == 0 {
			return t, fmt.Errorf("custom group %q: needs at least one member", g.Name)
		}
	}
```

- [ ] **Step 4: Run, expect PASS** — `go test ./internal/plugins/subgen/ -run TestParseTemplate_CustomGroups`.

- [ ] **Step 5: gofmt + commit**
```bash
gofmt -l internal/plugins/subgen/template.go internal/plugins/subgen/template_test.go
git add internal/plugins/subgen/template.go internal/plugins/subgen/template_test.go
git commit -m "feat(subgen): custom_groups field + validation"
```

---

## Task 2: `Group.Verbatim` + `Assemble` appends custom groups

**Files:**
- Modify: `internal/plugins/subgen/base.go`
- Test: `internal/plugins/subgen/base_test.go`

- [ ] **Step 1: Write the failing test** — append to `internal/plugins/subgen/base_test.go`:

```go
func TestAssemble_AppendsCustomGroups(t *testing.T) {
	spec := TemplateSpec{
		Final:             "PROXY",
		IncludeAutoSelect: true,
		Categories:        []CategorySel{{Name: "Telegram", Policy: "PROXY"}},
		CustomGroups:      []CustomGroup{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "DIRECT"}}},
	}
	im := Assemble(nil, spec)
	g := findGroup(im.Groups, "Home")
	if g == nil || g.Type != "select" || !g.Verbatim || !equalStrings(g.Members, []string{"DEVICE:HomeMac", "DIRECT"}) {
		t.Fatalf("Home group = %+v", g)
	}
	// custom group precedes the category group
	if hi, ti := groupIndex(im.Groups, "Home"), groupIndex(im.Groups, "Telegram"); hi < 0 || ti < 0 || hi > ti {
		t.Fatalf("custom group should precede category group: Home@%d Telegram@%d", hi, ti)
	}
}

func groupIndex(gs []Group, name string) int {
	for i := range gs {
		if gs[i].Name == name {
			return i
		}
	}
	return -1
}
```

- [ ] **Step 2: Run, expect FAIL** — `go test ./internal/plugins/subgen/ -run TestAssemble_AppendsCustomGroups` (build error: `Group.Verbatim` / `CustomGroup` field; assertion).

- [ ] **Step 3: Add `Verbatim` to `Group`** — In `internal/plugins/subgen/base.go`, change the `Group` struct:
```go
type Group struct {
	Name     string
	Type     string // "select" | "url-test"
	Members  []string
	Verbatim bool // user-defined: render members exactly, no auto-DIRECT fallback
}
```

- [ ] **Step 4: Append custom groups in `Assemble`** — In `internal/plugins/subgen/base.go`, locate the block that appends the `Auto Select` url-test group:
```go
	if spec.IncludeAutoSelect {
		im.Groups = append(im.Groups, Group{Name: autoSelectGroup, Type: "url-test", Members: allNames})
	}
```
Immediately AFTER that block (and before the `for _, c := range spec.Categories {` category-groups loop), insert:
```go
	for _, cg := range spec.CustomGroups {
		im.Groups = append(im.Groups, Group{Name: cg.Name, Type: cg.Type, Members: cg.Members, Verbatim: true})
	}
```

- [ ] **Step 5: Run, expect PASS** — `go test ./internal/plugins/subgen/ -run TestAssemble_AppendsCustomGroups`; then full `go test ./internal/plugins/subgen/` (existing tests unaffected — `Verbatim` defaults false).

- [ ] **Step 6: gofmt + commit**
```bash
gofmt -l internal/plugins/subgen/
git add internal/plugins/subgen/base.go internal/plugins/subgen/base_test.go
git commit -m "feat(subgen): Assemble appends verbatim custom groups"
```

---

## Task 3: Surge/ShadowRocket — verbatim groups + DEVICE filtering

**Files:**
- Modify: `internal/plugins/subgen/render.go`, `render_surge.go`, `render_shadowrocket.go`
- Test: `internal/plugins/subgen/render_surge_test.go`, `render_shadowrocket_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `internal/plugins/subgen/render_surge_test.go`:
```go
func TestSurge_CustomGroupVerbatimKeepsDevice(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "PROXY"}, Verbatim: true}},
		Rules:  []Rule{{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"}, {Final: true, Target: "PROXY"}},
	}
	out := (&SurgeRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "Home = select, DEVICE:HomeMac, PROXY\n") {
		t.Fatalf("surge verbatim group:\n%s", out)
	}
	if strings.Contains(out, "DEVICE:HomeMac, PROXY, DIRECT") {
		t.Fatalf("verbatim group must not get auto-DIRECT:\n%s", out)
	}
	if !strings.Contains(out, "IP-CIDR,192.168.1.0/24,DEVICE:HomeMac") {
		t.Fatalf("surge keeps DEVICE rule:\n%s", out)
	}
}
```

Append to `internal/plugins/subgen/render_shadowrocket_test.go`:
```go
func TestShadowRocket_FiltersDevice(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "DIRECT"}, Verbatim: true}},
		Rules:  []Rule{{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"}, {Final: true, Target: "PROXY"}},
	}
	out := (&ShadowRocketRenderer{}).Render(im, "x", DefaultRulesetBase)
	if !strings.Contains(out, "Home = select, DIRECT\n") {
		t.Fatalf("shadowrocket should filter DEVICE member:\n%s", out)
	}
	if strings.Contains(out, "DEVICE:") {
		t.Fatalf("shadowrocket must drop all DEVICE refs:\n%s", out)
	}
}
```

- [ ] **Step 2: Run, expect FAIL** — `go test ./internal/plugins/subgen/ -run 'TestSurge_CustomGroupVerbatimKeepsDevice|TestShadowRocket_FiltersDevice'` (verbatim not honored → auto-DIRECT appended; DEVICE not filtered for shadowrocket).

- [ ] **Step 3: Add `dropDevicePolicies` to `render.go`** — In `internal/plugins/subgen/render.go`, add a `strings` import and this helper:
```go
import "strings"

// dropDevicePolicies removes Surge-only DEVICE: members (Surge Ponte). Clash and
// ShadowRocket have no Ponte equivalent, so those renderers filter them out.
func dropDevicePolicies(members []string) []string {
	out := make([]string, 0, len(members))
	for _, m := range members {
		if !strings.HasPrefix(m, "DEVICE:") {
			out = append(out, m)
		}
	}
	return out
}
```

- [ ] **Step 4: `render_surge.go` — flavor flag + filtering**

(a) Change the public delegate:
```go
func (r *SurgeRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, false)
}
```
to:
```go
func (r *SurgeRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "surge")
}
```

(b) Change the `render` doc comment + signature + add the flag locals. Replace:
```go
// render builds the Surge-family .conf. wgInline selects WireGuard handling:
// false → a [WireGuard <section>] block + a section-name proxy reference (Surge);
// true → a single inline [Proxy] line (ShadowRocket).
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase string, wgInline bool) string {
	var b strings.Builder
```
with:
```go
// render builds the Surge-family .conf for target "surge" or "shadowrocket".
// ShadowRocket gets inline WireGuard ([Proxy] line) and, having no Ponte, filters
// out Surge-only DEVICE: members/rules; Surge keeps them.
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase, target string) string {
	wgInline := target == "shadowrocket"
	filterDevice := target != "surge"
	var b strings.Builder
```

(c) Replace the `[Proxy Group]` loop:
```go
	b.WriteString("\n[Proxy Group]\n")
	for _, g := range im.Groups {
		b.WriteString(r.groupLine(g) + "\n")
	}
```
with:
```go
	b.WriteString("\n[Proxy Group]\n")
	for _, g := range im.Groups {
		if filterDevice {
			if g.Members = dropDevicePolicies(g.Members); len(g.Members) == 0 {
				continue
			}
		}
		b.WriteString(r.groupLine(g) + "\n")
	}
```

(d) Replace the `[Rule]` loop:
```go
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(surgeRuleLine(rule, rulesetBase) + "\n")
	}
```
with:
```go
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		if filterDevice && strings.HasPrefix(rule.Target, "DEVICE:") {
			continue
		}
		b.WriteString(surgeRuleLine(rule, rulesetBase) + "\n")
	}
```

(e) Make `groupLine` honor `Verbatim`. Replace:
```go
	// select groups carry DIRECT as the conventional fallback member — append
	// it only when the group doesn't already include it (category groups do).
	members := g.Members
	hasDirect := false
	for _, m := range members {
		if m == "DIRECT" {
			hasDirect = true
			break
		}
	}
	if !hasDirect {
		members = append(append([]string{}, members...), "DIRECT")
	}
	return fmt.Sprintf("%s = select, %s", g.Name, strings.Join(members, ", "))
```
with:
```go
	// Auto-generated select groups carry DIRECT as the conventional fallback;
	// user-defined (Verbatim) groups render their members exactly.
	members := g.Members
	if !g.Verbatim {
		hasDirect := false
		for _, m := range members {
			if m == "DIRECT" {
				hasDirect = true
				break
			}
		}
		if !hasDirect {
			members = append(append([]string{}, members...), "DIRECT")
		}
	}
	return fmt.Sprintf("%s = select, %s", g.Name, strings.Join(members, ", "))
```

- [ ] **Step 5: `render_shadowrocket.go` — pass the target** — change:
```go
func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, true)
}
```
to:
```go
func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, "shadowrocket")
}
```

- [ ] **Step 6: Run, expect PASS** — `go test ./internal/plugins/subgen/` → new tests + ALL existing (the WireGuard tests still pass: `wgInline` is now `target=="shadowrocket"`; non-verbatim/non-DEVICE output is unchanged).

- [ ] **Step 7: gofmt + commit**
```bash
gofmt -l internal/plugins/subgen/
git add internal/plugins/subgen/render.go internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_shadowrocket.go internal/plugins/subgen/render_surge_test.go internal/plugins/subgen/render_shadowrocket_test.go
git commit -m "feat(subgen): verbatim custom groups; filter DEVICE for shadowrocket"
```

---

## Task 4: Clash — filter DEVICE from groups + rules

**Files:**
- Modify: `internal/plugins/subgen/render_clash.go`
- Test: `internal/plugins/subgen/render_clash_test.go`

- [ ] **Step 1: Write the failing test** — append to `internal/plugins/subgen/render_clash_test.go`:
```go
func TestClash_FiltersDevice(t *testing.T) {
	im := Intermediate{
		Groups: []Group{{Name: "Home", Type: "select", Members: []string{"DEVICE:HomeMac", "DIRECT"}, Verbatim: true}},
		Rules:  []Rule{{Match: "IP-CIDR,192.168.1.0/24", Target: "DEVICE:HomeMac"}, {Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "DEVICE:") {
		t.Fatalf("clash must drop DEVICE refs:\n%s", out)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	if !strings.Contains(out, "name: Home") {
		t.Fatalf("Home group missing:\n%s", out)
	}
}
```

- [ ] **Step 2: Run, expect FAIL** — `go test ./internal/plugins/subgen/ -run TestClash_FiltersDevice` (DEVICE: appears in proxy-groups and rules).

- [ ] **Step 3: Filter in `render_clash.go`**

(a) In the proxy-groups loop, replace:
```go
	groups := []map[string]any{}
	for _, g := range im.Groups {
		m := map[string]any{"name": g.Name, "type": g.Type, "proxies": g.Members}
		if g.Type == "url-test" {
			m["url"] = "http://www.gstatic.com/generate_204"
			m["interval"] = 300
		}
		groups = append(groups, m)
	}
```
with:
```go
	groups := []map[string]any{}
	for _, g := range im.Groups {
		members := dropDevicePolicies(g.Members) // Clash has no Ponte
		if len(members) == 0 {
			continue
		}
		m := map[string]any{"name": g.Name, "type": g.Type, "proxies": members}
		if g.Type == "url-test" {
			m["url"] = "http://www.gstatic.com/generate_204"
			m["interval"] = 300
		}
		groups = append(groups, m)
	}
```

(b) In the rules loop, add a skip at the top of the `for _, rl := range im.Rules {` body (before the `switch`):
```go
	for _, rl := range im.Rules {
		if strings.HasPrefix(rl.Target, "DEVICE:") {
			continue
		}
		switch {
```

- [ ] **Step 4: Run, expect PASS** — `go test ./internal/plugins/subgen/ -run 'TestClash'` (new + existing Clash tests).

- [ ] **Step 5: gofmt + commit**
```bash
gofmt -l internal/plugins/subgen/
git add internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_clash_test.go
git commit -m "feat(subgen): Clash filters DEVICE members/rules (no Ponte)"
```

---

## Task 5: Editor — custom-groups field

**Files:**
- Modify: `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`

- [ ] **Step 1: Add the model type + RulesModel field**

After the `interface CustomRule { ... }` line, add:
```tsx
interface CustomGroupModel { name: string; type: string; members: string[] }
```
In `interface RulesModel { ... }`, add after `custom_nodes: string`:
```tsx
  custom_groups: CustomGroupModel[]
```

- [ ] **Step 2: Add text ↔ struct helpers** — after the `textToCustomRules` function, add:
```tsx
function customGroupsToText(groups: CustomGroupModel[]): string {
  return groups.map((g) => `${g.name} = ${g.type}, ${g.members.join(', ')}`).join('\n')
}

function textToCustomGroups(text: string): CustomGroupModel[] {
  const out: CustomGroupModel[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    const eq = t.indexOf('=')
    if (eq < 0) continue
    const name = t.slice(0, eq).trim()
    const parts = t.slice(eq + 1).split(',').map((p) => p.trim()).filter(Boolean)
    if (!name || parts.length < 2) continue // need a type + at least one member
    out.push({ name, type: parts[0], members: parts.slice(1) })
  }
  return out
}
```

- [ ] **Step 3: Parse in `parseRules`** — add to the returned object after `custom_nodes: String(raw.custom_nodes ?? ''),`:
```tsx
    custom_groups: Array.isArray(raw.custom_groups)
      ? raw.custom_groups.map((g: any) => ({
          name: String(g.name ?? ''),
          type: String(g.type ?? 'select'),
          members: Array.isArray(g.members) ? g.members.map((m: any) => String(m)) : [],
        }))
      : [],
```

- [ ] **Step 4: Editor state** — in `TemplateEditor`, after `const [customNodes, setCustomNodes] = useState(initial.custom_nodes)`:
```tsx
  const [customGroupsText, setCustomGroupsText] = useState(customGroupsToText(initial.custom_groups))
```

- [ ] **Step 5: `buildModel`** — add after `custom_nodes: customNodes,`:
```tsx
    custom_groups: textToCustomGroups(customGroupsText),
```

- [ ] **Step 6: `switchToForm`** — add after `setCustomNodes(m.custom_nodes)`:
```tsx
    setCustomGroupsText(customGroupsToText(m.custom_groups))
```

- [ ] **Step 7: Add the textarea** — immediately after the Custom-nodes textarea's closing `</div>` (the block whose textarea `placeholder` starts with `vless://uuid@host:443`), insert:
```tsx
                <div>
                  <Label className="text-[12px]">Custom groups</Label>
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-1">
                    One group per line: <code>Name = type, member1, member2</code> (type = select or url-test). Members are free text (node names, PROXY/DIRECT/REJECT, <code>DEVICE:Name</code> for Surge Ponte, or other group names). Target a group from a custom rule. <code>DEVICE:</code> members render only for Surge.
                  </p>
                  <textarea
                    value={customGroupsText}
                    onChange={(e) => setCustomGroupsText(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    className="w-full px-2 py-1.5 rounded-md border bg-background text-[12px] font-mono"
                    placeholder="Home = select, DEVICE:HomeMac, DIRECT"
                  />
                </div>
```

- [ ] **Step 8: Typecheck + tests** — `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run` (clean + all pass), then `cd /Users/hg/project/Shepherd`.

- [ ] **Step 9: Commit**
```bash
git add web/src/pages/admin/plugins/subgen/TemplatesTab.tsx
git commit -m "feat(subgen): custom-groups field in template editor"
```

---

## Task 6: Docs

**Files:**
- Modify: `docs/subgen.md`

- [ ] **Step 1: Add a section** — insert immediately AFTER the `## 自定义节点（分享链接）` section's last paragraph (the `注意：自定义节点属于**模板**…` line) and before the next `## ` heading:
```markdown

## 自定义代理组（Custom groups）

模板可定义自己的命名代理组,每行 `名字 = 类型, 成员1, 成员2`(类型 = `select` 或 `url-test`)。成员是自由文本:节点名、`PROXY`/`DIRECT`/`REJECT`、`DEVICE:Name`(Surge Ponte 内网设备)、或其它组名。组成员**原样渲染**(不自动追加 DIRECT)。用自定义规则指向组名即可路由,例如:

- 组:`Home = select, DEVICE:HomeMac, DIRECT`
- 规则:`IP-CIDR,192.168.1.0/24,Home`

`DEVICE:` 是 **Surge 专有**(Ponte);**Clash 与 ShadowRocket 会自动过滤** `DEVICE:` 成员与以 `DEVICE:` 为策略的规则。跨格式使用的组请至少保留一个非 `DEVICE:` 成员(如 `DIRECT`)。
```

- [ ] **Step 2: Commit**
```bash
git add docs/subgen.md
git commit -m "docs(subgen): document custom groups + Ponte/DEVICE"
```

---

## Task 7: Full-suite verification

**Files:** none

- [ ] **Step 1: Go** — `go build ./... && go test ./... && gofmt -l internal/plugins/subgen/ && go vet ./internal/plugins/subgen/` → build clean, all `ok`, no gofmt output, vet clean. `rm -f server` if a binary appears.
- [ ] **Step 2: FE** — `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run && cd /Users/hg/project/Shepherd` → tsc clean, vitest all pass.
- [ ] **Step 3: Clean tree** — `git status --short` (restore `internal/web/dist/.gitkeep` with `git checkout -- internal/web/dist/.gitkeep` if a build removed it).

---

## Self-Review (completed by plan author)

**Spec coverage:**
- Structured `custom_groups {name,type,members}` + validation → Task 1. ✓
- `Group.Verbatim` + Assemble appends (after Auto Select, before categories) → Task 2. ✓
- Verbatim render (no auto-DIRECT); `render` flavor `wgInline`→`target`; Surge keeps DEVICE; ShadowRocket filters DEVICE members + rules → Task 3. ✓
- Clash filters DEVICE members + rules; empty group dropped → Task 4 (+ Task 3 drop-empty for surge-family). ✓
- Editor textarea (text↔struct) → Task 5. ✓
- Docs (incl. DEVICE Surge-only + non-DEVICE-member recommendation) → Task 6. ✓
- Routing reuses existing custom rules → no task needed (validPolicy already permits group names/DEVICE). ✓
- No migration → inherent. ✓

**Placeholder scan:** none.

**Type/name consistency:** `CustomGroup{Name,Type,Members}` (Go) / `CustomGroupModel{name,type,members}` (TS); `Group.Verbatim`; `dropDevicePolicies` (render.go) used by render_surge.go + render_clash.go; `render(im, subURL, rulesetBase, target string)` with `wgInline := target=="shadowrocket"` preserves WireGuard; `customGroupsToText`/`textToCustomGroups`. The empty-after-filter group is skipped in both the Surge-family loop and the Clash loop.
