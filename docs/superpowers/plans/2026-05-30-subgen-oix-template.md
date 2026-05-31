# Subgen fixed dler.io/oixCloud Template — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make subgen's Surge + Clash output the fixed dler.io/oixCloud template (full [General]/DNS, ~28 proxy groups, dler.io rule-sets, [Host]/[Script]/[Panel]), with the user's nodes injected and the existing custom logic (custom rules/groups/nodes, free-text, DOMAIN-SET) layered on.

**Architecture:** Two templatized copies of the reference configs are embedded; the renderers become marker-fillers (substitute `{{PROXIES}}`/`{{WIREGUARD}}`/`{{NODES}}`/`{{CUSTOM_RULES}}`/`{{CUSTOM_GROUPS}}`/free-text markers, emit the rest verbatim). `Assemble` stops expanding categories — `im.Groups`/`im.Rules` now carry only custom groups/rules.

**Tech Stack:** Go, `//go:embed`, text substitution (Clash injected as text to preserve formatting), gopkg.in/yaml.v3 (validation only), the existing per-protocol node helpers.

**Spec:** `docs/superpowers/specs/2026-05-30-subgen-oix-template-design.md`
**Reference (gitignored, local only):** `tmp/oixCloudSurge`, `tmp/oixCloudClash`.

Run from `/Users/hg/project/Shepherd`; never `git checkout`/`reset`/`stash` (commit on `feat/subgen-oix-template`). Run `golangci-lint run --timeout=5m` before finishing Go work. Reference node-name list = each node's `n.Name`. up=tx/down=rx unchanged.

---

## Task 1: Generate + embed the two `.tmpl` assets; gitignore tmp/

**Files:**
- Create: `internal/plugins/subgen/templates/oix_surge.tmpl`
- Create: `internal/plugins/subgen/templates/oix_clash.tmpl`
- Create: `internal/plugins/subgen/templates/embed.go`
- Modify: `.gitignore`

- [ ] **Step 1: gitignore the reference dir** — append to `.gitignore`:
```
# Local-only design reference configs (templatized copies live under
# internal/plugins/subgen/templates/)
/tmp/
```
Run: `cd /Users/hg/project/Shepherd && git status --short | grep -c '^?? tmp/' || true` then `git check-ignore tmp/oixCloudSurge` — expect it prints `tmp/oixCloudSurge` (now ignored).

- [ ] **Step 2: generate the templatized copies.** Write this transform script to `tmp/gen_tmpl.py` (tmp/ is gitignored — the script is scratch, NOT committed) and run it. It reads the two reference files and writes the two `.tmpl` files with markers; the node-name runs in groups are replaced using the exact node names parsed from the proxy section (deterministic, no emoji heuristics).

```python
# tmp/gen_tmpl.py
import re, sys

def surge():
    src = open("tmp/oixCloudSurge").read().splitlines()
    out, i, n = [], 0, len(src)
    # collect node names = LHS of '=' for lines between [Proxy] and [Proxy Group],
    # excluding the fixed Direct/Block declarations.
    names = []
    inproxy = False
    for ln in src:
        if ln.strip() == "[Proxy]": inproxy = True; continue
        if ln.strip() == "[Proxy Group]": inproxy = False
        if inproxy and "=" in ln:
            lhs = ln.split("=",1)[0].strip()
            if lhs and lhs not in ("Direct","Block"): names.append(lhs)
    nameset = set(names)
    res = []
    section = None
    for ln in src:
        s = ln.strip()
        if s.startswith("[") and s.endswith("]"): section = s
        # [Proxy] body: keep Direct/Block, drop node defs, insert markers once
        if section == "[Proxy]" and "=" in ln and ln.split("=",1)[0].strip() in nameset:
            if "{{PROXIES}}" not in res:
                res.append("{{PROXIES}}")
                res.append("{{WIREGUARD}}")
            continue
        # [Proxy Group] lines: strip node tokens, append {{NODES}}; also insert
        # {{CUSTOM_GROUPS}} right before the section ends (handled at [Rule]).
        if section == "[Proxy Group]" and "=" in ln and ln.split("=",1)[0].strip() not in ("",):
            head, _, rest = ln.partition("=")
            toks = [t.strip() for t in rest.split(",")]
            kept, hadnode = [], False
            for t in toks:
                if t in nameset: hadnode = True; continue
                kept.append(t)
            line = head + "= " + ", ".join(kept)
            if hadnode: line += ", {{NODES}}"
            res.append(line); continue
        if s == "[Rule]":
            res.append("{{CUSTOM_GROUPS}}")   # end of the preceding [Proxy Group]
            res.append(ln)
            res.append("{{CUSTOM_RULES}}")
            continue
        res.append(ln)
    text = "\n".join(res) + "\n"
    # free-text markers appended to sections
    text = text.replace("exclude-simple-hostnames = true",
                        "exclude-simple-hostnames = true\n{{GENERAL_EXTRA}}", 1)
    # [URL Rewrite]: append marker after the section's last rewrite line
    text = re.sub(r"(\[URL Rewrite\]\n(?:.*\n)*?)\n\n", r"\1{{URLREWRITE_EXTRA}}\n\n", text, count=1)
    text += "\n{{MITM}}\n"
    open("internal/plugins/subgen/templates/oix_surge.tmpl","w").write(text)
    print("surge nodes:", len(names))

def clash():
    src = open("tmp/oixCloudClash").read().splitlines()
    # node names = the name: value of each '- { name: ... }' under proxies:
    names = []
    inprox = False
    for ln in src:
        if ln.strip() == "proxies:": inprox = True; continue
        if inprox and re.match(r"^[a-zA-Z_-]+:", ln): inprox = False
        if inprox:
            m = re.search(r"name:\s*('?)(.+?)\1\s*,", ln)
            if m: names.append(m.group(2))
    nameset = set(names)
    res, section, inprox = [], None, False
    for ln in src:
        if re.match(r"^[a-zA-Z_-]+:", ln): section = ln.split(":")[0]
        if ln.strip() == "proxies:":
            res.append(ln); res.append("{{PROXIES}}"); inprox = True; continue
        if inprox:
            if re.match(r"^[a-zA-Z_-]+:", ln): inprox = False  # fallthrough to emit
            else:
                continue  # drop node def lines
        if section == "proxy-groups" and "name:" in ln and "proxies:" in ln:
            # strip node tokens inside proxies:[...]
            def strip_nodes(m):
                inner = m.group(1)
                toks = [t.strip() for t in inner.split(",")]
                kept, hadnode = [], False
                for t in toks:
                    bare = t.strip().strip("'")
                    if bare in nameset: hadnode = True; continue
                    kept.append(t)
                joined = ", ".join(kept)
                if hadnode: joined += (", " if kept else "") + "{{NODES}}"
                return "proxies: [" + joined + "]"
            ln = re.sub(r"proxies:\s*\[(.*?)\]", strip_nodes, ln)
        if ln.strip() == "rules:":
            res.append(ln); res.append("{{CUSTOM_RULES}}"); continue
        if ln.strip() == "rule-providers:":
            res.insert(len(res), "{{CUSTOM_GROUPS}}")  # end of proxy-groups precedes rules; place custom groups after proxy-groups
        res.append(ln)
    text = "\n".join(res) + "\n"
    text += "{{CLASH_EXTRA}}\n"
    open("internal/plugins/subgen/templates/oix_clash.tmpl","w").write(text)
    print("clash nodes:", len(names))

surge(); clash()
```
Run: `cd /Users/hg/project/Shepherd && mkdir -p internal/plugins/subgen/templates && python3 tmp/gen_tmpl.py`
> Implementer note: this script is best-effort scaffolding — after running it, **manually verify and fix** the two `.tmpl` files (Step 3). The `{{CUSTOM_GROUPS}}` placement for Clash must sit at the END of the `proxy-groups:` list (just before `rules:`), and for Surge at the end of `[Proxy Group]` (just before `[Rule]`). Adjust the script or hand-edit so the markers land correctly. Commit ONLY the two `.tmpl` files (+ embed.go), never the script or tmp/.

- [ ] **Step 3: verify the `.tmpl` files by hand + asserts.** Confirm each contains every marker exactly once where appropriate and NO residual oixCloud node name (`🇭🇰 香港 CIA 01` etc.):
```
cd /Users/hg/project/Shepherd
for f in internal/plugins/subgen/templates/oix_surge.tmpl internal/plugins/subgen/templates/oix_clash.tmpl; do
  echo "== $f =="
  for m in '{{PROXIES}}' '{{NODES}}' '{{CUSTOM_RULES}}' '{{CUSTOM_GROUPS}}'; do
    grep -qF "$m" "$f" && echo "  has $m" || echo "  MISSING $m"
  done
  grep -qF '香港 CIA 01' "$f" && echo "  !! residual node name" || echo "  no residual node names"
done
grep -qF '{{WIREGUARD}}' internal/plugins/subgen/templates/oix_surge.tmpl && echo "surge has WIREGUARD"
```
Expected: surge has PROXIES/WIREGUARD/NODES/CUSTOM_RULES/CUSTOM_GROUPS + no residual; clash has PROXIES/NODES/CUSTOM_RULES/CUSTOM_GROUPS + no residual. Hand-fix the `.tmpl` until clean (the render tests in Tasks 3–4 are the real gate).

- [ ] **Step 4: embed.go**
```go
// Package templates holds the embedded fixed Surge/Clash base templates
// (templatized dler.io/oixCloud configs). The renderers fill the {{...}}
// markers with the user's nodes + custom logic.
package templates

import _ "embed"

//go:embed oix_surge.tmpl
var Surge string

//go:embed oix_clash.tmpl
var Clash string
```

- [ ] **Step 5: build + commit**

Run: `cd /Users/hg/project/Shepherd && go build ./internal/plugins/subgen/... && gofmt -l internal/plugins/subgen/templates/embed.go`
Expected: build OK; gofmt empty.
```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/templates/ .gitignore
git status --short | grep -q '^A.*tmp/' && echo "ABORT: tmp staged" || true
git commit -m "feat(subgen): embed templatized dler.io/oixCloud Surge+Clash base templates"
```

---

## Task 2: `Assemble` — narrow Groups/Rules to custom-only

**Files:**
- Modify: `internal/plugins/subgen/base.go`
- Test: `internal/plugins/subgen/base_test.go` (or wherever Assemble is tested)

- [ ] **Step 1: Update the failing tests.** Find existing Assemble tests (`grep -rn "func Test.*Assemble\|Assemble(" internal/plugins/subgen/*_test.go`). The category-expansion + PROXY/Auto-Select/Final assertions are now wrong. Replace them with: `Assemble` returns `im.Groups` = ONLY the custom groups (Verbatim), `im.Rules` = ONLY the custom rules, and `im.Nodes` = selected + custom nodes. Add:
```go
func TestAssemble_CustomOnly(t *testing.T) {
	spec := TemplateSpec{
		Categories:   []CategorySel{{Name: "AI", Policy: "PROXY"}},
		CustomRules:  []CustomRule{{Match: "DOMAIN,x.com", Policy: "DIRECT"}},
		CustomGroups: []CustomGroup{{Name: "G", Type: "select", Members: []string{"DIRECT"}}},
		Final:        "PROXY",
	}
	im := Assemble([]Node{{Name: "n1"}}, spec)
	if len(im.Nodes) != 1 || im.Nodes[0].Name != "n1" {
		t.Fatalf("nodes: %+v", im.Nodes)
	}
	// categories no longer expand into groups/rules
	if len(im.Groups) != 1 || im.Groups[0].Name != "G" || !im.Groups[0].Verbatim {
		t.Fatalf("groups should be custom-only: %+v", im.Groups)
	}
	if len(im.Rules) != 1 || im.Rules[0].Match != "DOMAIN,x.com" || im.Rules[0].Target != "DIRECT" {
		t.Fatalf("rules should be custom-only: %+v", im.Rules)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestAssemble_CustomOnly -v`
Expected: FAIL — categories still expand / PROXY group present.

- [ ] **Step 3: Rewrite `Assemble`** in `base.go` — drop the PROXY/Auto-Select groups, the category groups, the category rules, and the Final rule (the template owns all of those):
```go
// Assemble builds the target-agnostic model for the fixed-template renderers.
// The base template (dler.io/oixCloud) owns the proxy-group taxonomy, the
// rule-sets, and the catch-all; Assemble carries only what the user customizes:
// the node set (selected + custom), the custom groups, the custom rules, and the
// free-text section bodies. spec.Categories no longer affects output.
func Assemble(nodes []Node, spec TemplateSpec) Intermediate {
	if custom, _ := ParseShareLinks(spec.CustomNodes); len(custom) > 0 {
		nodes = append(nodes, custom...)
	}
	dedupeNodeNames(nodes)
	im := Intermediate{
		Nodes:        nodes,
		General:      spec.General,
		MITM:         spec.MITM,
		URLRewrite:   spec.URLRewrite,
		ClashGeneral: spec.ClashGeneral,
	}
	for _, cg := range spec.CustomGroups {
		members := append([]string(nil), cg.Members...)
		im.Groups = append(im.Groups, Group{Name: cg.Name, Type: cg.Type, Members: members, Verbatim: true})
	}
	for _, r := range spec.CustomRules {
		im.Rules = append(im.Rules, Rule{Match: r.Match, Target: r.Policy})
	}
	return im
}
```
Delete the now-unused `autoSelectGroup`/`mainProxyGroup` consts + `dedupeStrings` IF nothing else uses them (`grep` first; if `dedupeStrings`/`categoryByName` are used elsewhere e.g. the `/categories` endpoint, leave them). Remove the `categoryByName` loop import usage from base.go only.

- [ ] **Step 4: Run to verify pass + full package**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestAssemble_CustomOnly -v && go build ./internal/plugins/subgen/... && go vet ./internal/plugins/subgen/`
Expected: the new test PASS; build OK; vet clean. (Other subgen tests will fail here — they assert old render output; they're fixed in Tasks 3–4. That's expected mid-refactor; do NOT fix them in this task.)

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/base.go internal/plugins/subgen/base_test.go
git commit -m "refactor(subgen): Assemble carries custom-only groups/rules (template owns the rest)"
```

---

## Task 3: Surge renderer — fill the template

**Files:**
- Modify: `internal/plugins/subgen/render_surge.go`
- Test: `internal/plugins/subgen/render_surge_test.go`

- [ ] **Step 1: Rewrite the failing tests.** The old `TestSurge_*` tests assert the hand-built sections; replace the structural ones (keep DOMAIN-SET/insecure/WireGuard intent). Add the template tests:
```go
func TestSurge_FillsTemplate(t *testing.T) {
	im := Intermediate{
		Nodes:  []Node{{Name: "🟢 A", Protocol: "shadowsocks", Server: "1.1.1.1", Port: 8388, SSMethod: "aes-256-gcm", Password: "p"}},
		Groups: []Group{{Name: "MyGroup", Type: "select", Members: []string{"DIRECT"}, Verbatim: true}},
		Rules:  []Rule{{Match: "DOMAIN,x.com", Target: "DIRECT"}},
		General: "ipv6 = true",
	}
	out := (&SurgeRenderer{}).Render(im, "https://sub", DefaultRulesetBase)
	if strings.Contains(out, "{{") {
		t.Fatalf("unresolved marker:\n%s", out)
	}
	// node defined + referenced in the fixed Proxy group
	if !strings.Contains(out, "🟢 A = ss,") {
		t.Errorf("missing proxy def\n%s", out)
	}
	if !strings.Contains(out, "Proxy = select,") || !strings.Contains(out, "🟢 A") {
		t.Errorf("node not in groups\n%s", out)
	}
	// custom rule appears in [Rule], BEFORE the first dler.io RULE-SET
	ri := strings.Index(out, "DOMAIN,x.com,DIRECT")
	di := strings.Index(out, "RULE-SET,https://fastly.jsdelivr.net")
	if ri < 0 || di < 0 || ri > di {
		t.Errorf("custom rule must precede dler.io rules (ri=%d di=%d)", ri, di)
	}
	// custom group + free-text general + fixed sections present
	if !strings.Contains(out, "MyGroup = select, DIRECT") {
		t.Errorf("custom group missing\n%s", out)
	}
	if !strings.Contains(out, "ipv6 = true") || !strings.Contains(out, "[Host]") || !strings.Contains(out, "[Panel]") {
		t.Errorf("free-text/fixed sections missing\n%s", out)
	}
}
```
> Keep `TestSurge_DomainSetVerbatim` (custom rule passes DOMAIN-SET through for surge) — it still holds via `{{CUSTOM_RULES}}`. Keep a WireGuard test asserting a `[WireGuard wg0]` block + `section-name=wg0` appears (via `{{WIREGUARD}}`/`{{PROXIES}}`).

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestSurge_FillsTemplate -v`
Expected: FAIL (old renderer output, markers/sections absent).

- [ ] **Step 3: Rewrite `render`** in `render_surge.go` to fill `templates.Surge`. Add import `"github.com/hg-claw/Shepherd/internal/plugins/subgen/templates"`. Replace the `render` method body with marker substitution (keep `proxyLine`, `surgeWGSection`, `shadowrocketWGLine`, `groupLine`, `surgeRuleLine`, `dropDevicePolicies`):
```go
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase, target string) string {
	wgInline := target == "shadowrocket"
	filterDevice := target != "surge"

	// {{PROXIES}} + {{WIREGUARD}}: node defs (non-WG) then WG sections.
	var proxies, wg strings.Builder
	var names []string
	wgN := 0
	for _, n := range im.Nodes {
		if !r.Supports(n.Protocol) {
			continue
		}
		names = append(names, n.Name)
		if n.Protocol == "wireguard" {
			if wgInline {
				proxies.WriteString(shadowrocketWGLine(n) + "\n")
			} else {
				sec := fmt.Sprintf("wg%d", wgN)
				wgN++
				fmt.Fprintf(&proxies, "%s = wireguard, section-name=%s\n", n.Name, sec)
				wg.WriteString("\n" + surgeWGSection(n, sec))
			}
			continue
		}
		proxies.WriteString(r.proxyLine(n) + "\n")
	}

	// {{NODES}}: every node name, comma-joined (same in each group).
	nodeList := strings.Join(names, ", ")

	// {{CUSTOM_RULES}}: custom rules, one per line, before the dler.io rules.
	var crules strings.Builder
	for _, rule := range im.Rules {
		if filterDevice && strings.HasPrefix(rule.Target, "DEVICE:") {
			continue
		}
		crules.WriteString(surgeRuleLine(rule, rulesetBase) + "\n")
	}

	// {{CUSTOM_GROUPS}}: custom (Verbatim) groups.
	var cgroups strings.Builder
	for _, g := range im.Groups {
		if filterDevice {
			if g.Members = dropDevicePolicies(g.Members); len(g.Members) == 0 {
				continue
			}
		}
		cgroups.WriteString(r.groupLine(g) + "\n")
	}

	mitm := ""
	if m := strings.TrimSpace(im.MITM); m != "" {
		mitm = "[MITM]\n" + m + "\n"
	}

	out := templates.Surge
	out = strings.ReplaceAll(out, "{{PROXIES}}", strings.TrimRight(proxies.String(), "\n"))
	out = strings.ReplaceAll(out, "{{WIREGUARD}}", strings.TrimRight(wg.String(), "\n"))
	out = strings.ReplaceAll(out, "{{NODES}}", nodeList)
	out = strings.ReplaceAll(out, "{{CUSTOM_RULES}}", strings.TrimRight(crules.String(), "\n"))
	out = strings.ReplaceAll(out, "{{CUSTOM_GROUPS}}", strings.TrimRight(cgroups.String(), "\n"))
	out = strings.ReplaceAll(out, "{{GENERAL_EXTRA}}", strings.TrimSpace(im.General))
	out = strings.ReplaceAll(out, "{{URLREWRITE_EXTRA}}", strings.TrimSpace(im.URLRewrite))
	out = strings.ReplaceAll(out, "{{MITM}}", mitm)
	// prepend the managed-config header
	return fmt.Sprintf("#!MANAGED-CONFIG %s interval=43200 strict=false\n", subURL) + out
}
```
> Implementer note: `{{NODES}}` appears in many group lines — `ReplaceAll` fills them all identically (intended). If a fixed group line is `Name = select, Direct, Block, {{NODES}}` and the node list is empty, you'll get a trailing `, ` — acceptable for Surge, but if a render test flags it, trim a dangling `, {{NODES}}`→`` when `nodeList==""` (do a `strings.ReplaceAll(out, ", {{NODES}}", "")` BEFORE the plain `{{NODES}}` replace). The header is prepended (not in the template) so the `[General]`-first template body stays intact.

- [ ] **Step 4: Run tests + full subgen package + lint**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run 'Surge' -v && go test ./internal/plugins/subgen/ && gofmt -l internal/plugins/subgen/render_surge.go && go vet ./internal/plugins/subgen/ && golangci-lint run --timeout=5m`
Expected: Surge tests PASS; gofmt empty; vet clean; `0 issues`. (Clash tests still fail until Task 4 — run `-run Surge` for the focused pass; the full package will go green after Task 4.)

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_surge_test.go
git commit -m "feat(subgen): Surge renderer fills the fixed oixCloud template"
```

---

## Task 4: Clash renderer — fill the template (text injection)

**Files:**
- Modify: `internal/plugins/subgen/render_clash.go`
- Test: `internal/plugins/subgen/render_clash_test.go`

- [ ] **Step 1: Rewrite the failing tests.** Replace the structural `TestClash_*` tests; keep DOMAIN-SET + skip-cert-verify intent. Add:
```go
func TestClash_FillsTemplate(t *testing.T) {
	im := Intermediate{
		Nodes:  []Node{{Name: "🟢 A", Protocol: "trojan", Server: "1.1.1.1", Port: 443, Password: "p", SNI: "s.com"}},
		Groups: []Group{{Name: "MyGroup", Type: "select", Members: []string{"DIRECT"}, Verbatim: true}},
		Rules: []Rule{{Match: "DOMAIN-SET,https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master/rule/Shadowrocket/Advertising/Advertising_Domain.list", Target: "AdBlock"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	if strings.Contains(out, "{{") {
		t.Fatalf("unresolved marker:\n%s", out)
	}
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("not valid YAML: %v\n%s", err, out)
	}
	if !strings.Contains(out, "🟢 A") {
		t.Errorf("node missing\n%s", out)
	}
	// DOMAIN-SET custom rule converted to a behavior:domain provider + RULE-SET
	if !strings.Contains(out, "behavior: domain") || !strings.Contains(out, "RULE-SET,Advertising_Domain,AdBlock") {
		t.Errorf("DOMAIN-SET not converted\n%s", out)
	}
	if !strings.Contains(out, "MyGroup") {
		t.Errorf("custom group missing\n%s", out)
	}
	// the fixed dler.io rule-providers block is present
	if !strings.Contains(out, "fastly.jsdelivr.net/gh/dler-io") {
		t.Errorf("dler.io providers missing\n%s", out)
	}
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -run TestClash_FillsTemplate -v`
Expected: FAIL.

- [ ] **Step 3: Rewrite `Render`** in `render_clash.go` to fill `templates.Clash` by text substitution. Add import `"github.com/hg-claw/Shepherd/internal/plugins/subgen/templates"`. Keep `clashProxy`, the DOMAIN-SET helpers (`domainSetURL`/`clashDomainSetURL`/`domainSetName`), `dropDevicePolicies`. New body:
```go
func (r *ClashRenderer) Render(im Intermediate, _ string, rulesetBase string) string {
	// {{PROXIES}}: each node as a 4-space-indented YAML block-style list item.
	var proxies strings.Builder
	var names []string
	for _, n := range im.Nodes {
		px := clashProxy(n)
		if px == nil {
			continue
		}
		names = append(names, n.Name)
		b, err := yaml.Marshal([]map[string]any{px})
		if err != nil {
			continue
		}
		for _, line := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			proxies.WriteString("    " + line + "\n")
		}
	}

	// {{NODES}}: node names as a YAML inline-seq fragment (quoted).
	quoted := make([]string, 0, len(names))
	for _, nm := range names {
		quoted = append(quoted, "'"+strings.ReplaceAll(nm, "'", "''")+"'")
	}
	nodeList := strings.Join(quoted, ", ")

	// {{CUSTOM_RULES}}: custom rules as YAML rule strings, with DOMAIN-SET→provider.
	providers := map[string]string{} // name -> provider yaml line (indented)
	var crules strings.Builder
	for _, rl := range im.Rules {
		if strings.HasPrefix(rl.Target, "DEVICE:") {
			continue
		}
		if u, ok := domainSetURL(rl.Match); ok {
			url := clashDomainSetURL(u)
			name := domainSetName(url)
			if _, exists := providers[name]; !exists {
				format := "yaml"
				if !strings.HasSuffix(url, ".yaml") && !strings.HasSuffix(url, ".yml") {
					format = "text"
				}
				providers[name] = fmt.Sprintf("    %s: { type: http, behavior: domain, format: %s, url: '%s', path: ./ruleset/%s, interval: 86400 }",
					name, format, url, name)
			}
			crules.WriteString("    - 'RULE-SET," + name + "," + rl.Target + "'\n")
		} else {
			crules.WriteString("    - '" + rl.Match + "," + rl.Target + "'\n")
		}
	}
	// custom DOMAIN-SET providers append into the rule-providers block.
	var cproviders strings.Builder
	for _, line := range providers {
		cproviders.WriteString(line + "\n")
	}

	// {{CUSTOM_GROUPS}}: custom groups as proxy-group list items.
	var cgroups strings.Builder
	for _, g := range im.Groups {
		members := dropDevicePolicies(g.Members)
		if len(members) == 0 {
			continue
		}
		q := make([]string, 0, len(members))
		for _, m := range members {
			q = append(q, "'"+strings.ReplaceAll(m, "'", "''")+"'")
		}
		extra := ""
		if g.Type == "url-test" {
			extra = ", url: 'http://www.gstatic.com/generate_204', interval: 300"
		}
		fmt.Fprintf(&cgroups, "    - { name: '%s', type: %s, proxies: [%s]%s }\n",
			strings.ReplaceAll(g.Name, "'", "''"), g.Type, strings.Join(q, ", "), extra)
	}

	out := templates.Clash
	out = strings.ReplaceAll(out, "{{PROXIES}}", strings.TrimRight(proxies.String(), "\n"))
	out = strings.ReplaceAll(out, ", {{NODES}}", commaPrefix(nodeList)) // avoid dangling comma when empty
	out = strings.ReplaceAll(out, "{{NODES}}", nodeList)
	out = strings.ReplaceAll(out, "{{CUSTOM_RULES}}", strings.TrimRight(crules.String(), "\n"))
	// custom groups + custom DOMAIN-SET providers
	out = strings.ReplaceAll(out, "{{CUSTOM_GROUPS}}", strings.TrimRight(cgroups.String()+cproviders.String(), "\n"))
	out = strings.ReplaceAll(out, "{{CLASH_EXTRA}}", strings.TrimSpace(im.ClashGeneral))
	return out
}

// commaPrefix returns ", "+list when list is non-empty, else "" — so an empty
// node list doesn't leave a dangling comma inside a group's proxies:[...].
func commaPrefix(list string) string {
	if list == "" {
		return ""
	}
	return ", " + list
}
```
> Implementer note: the `{{CUSTOM_GROUPS}}` marker placement (from Task 1) must be at the end of the `proxy-groups:` list. The custom DOMAIN-SET providers are appended there too for simplicity (mihomo accepts rule-providers defined after proxy-groups as long as the YAML is valid — they're top-level keys; if the marker can't host providers there, add a separate `{{CUSTOM_PROVIDERS}}` marker inside the `rule-providers:` block in Task 1 and split). VERIFY the output `yaml.Unmarshal`s — the test does. If providers-after-proxy-groups breaks YAML structure, move `cproviders` to its own marker in `rule-providers:`.

- [ ] **Step 4: Run tests + full subgen package (now all green) + lint**

Run: `cd /Users/hg/project/Shepherd && go test ./internal/plugins/subgen/ -v && gofmt -l internal/plugins/subgen/render_clash.go && go vet ./internal/plugins/subgen/ && golangci-lint run --timeout=5m`
Expected: ALL subgen tests PASS; gofmt empty; vet clean; `0 issues`.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
git add internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_clash_test.go
git commit -m "feat(subgen): Clash renderer fills the fixed oixCloud template (text injection)"
```

---

## Task 5: Full verification

- [ ] **Step 1: Full Go suite (with -race) + vet + build + lint**

Run: `cd /Users/hg/project/Shepherd && go build ./... && go test -race ./internal/plugins/subgen/... && go test ./... && go vet ./... && golangci-lint run --timeout=5m`
Expected: build OK; race-clean; all packages PASS; vet clean; `0 issues`.

- [ ] **Step 2: gofmt on changed Go files**

Run: `cd /Users/hg/project/Shepherd && gofmt -l internal/plugins/subgen/base.go internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_clash.go internal/plugins/subgen/templates/embed.go`
Expected: prints nothing.

- [ ] **Step 3: Confirm tmp/ untracked + ignored, tree clean**

Run: `cd /Users/hg/project/Shepherd && git check-ignore tmp/oixCloudSurge && git status --short`
Expected: prints `tmp/oixCloudSurge`; `git status` shows clean (no tmp/, no scratch script committed).

- [ ] **Step 4: Frontend untouched** (subgen-only change) — sanity:

Run: `cd /Users/hg/project/Shepherd && git diff --name-only origin/main..HEAD | grep -v '^docs/\|^internal/plugins/subgen/\|^.gitignore$' || echo "(only subgen + docs + gitignore changed)"`
Expected: only subgen/docs/.gitignore.

---

## Self-Review Notes

- **Spec coverage:** embedded templatized assets + gitignore tmp/ (Task 1) ✓; markers + verbatim rest (Task 1) ✓; Assemble custom-only, categories retired from rendering (Task 2) ✓; Surge fill — PROXIES/WIREGUARD/NODES/CUSTOM_RULES(before dler.io)/CUSTOM_GROUPS/free-text (Task 3) ✓; Clash fill via text + DOMAIN-SET conversion + valid YAML (Task 4) ✓; `-race`+lint verification (Task 5) ✓. Custom logic (nodes/rules/groups/free-text/DOMAIN-SET/insecure/DEVICE-surge-only) retained by reusing the existing helpers.
- **Type consistency:** `templates.Surge`/`templates.Clash` (string embeds) filled by both renderers. `Intermediate.{Nodes,Groups(custom),Rules(custom),General,MITM,URLRewrite,ClashGeneral}`. Reused helpers: `proxyLine`,`surgeWGSection`,`shadowrocketWGLine`,`groupLine`,`surgeRuleLine`,`clashProxy`,`dropDevicePolicies`,`domainSetURL`,`clashDomainSetURL`,`domainSetName`. Markers identical in template (Task 1) and substitution (Tasks 3–4).
- **Risk — the .tmpl generation (Task 1)** is the crux; the render tests (Tasks 3–4) assert "no unresolved `{{`" + valid YAML + node-placement, so a bad template is caught. The generator script is scratch (gitignored); only the `.tmpl` outputs are committed.
- **Lint gate:** every Go task + Task 5 run `golangci-lint run` (the v0.15.0 lesson).
