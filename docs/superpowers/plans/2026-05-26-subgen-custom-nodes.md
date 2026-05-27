# Custom Nodes via Share Links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a subgen template carry custom nodes as proxy share links (`vless://`/`ss://`/`vmess://`/`trojan://`/`hysteria2://`/`tuic://`/`anytls://`), parsed into the unified `Node` model and merged with inbound nodes for rendering.

**Architecture:** Add a free-text `custom_nodes` field to `TemplateSpec` (stored in `rules_json`, like `general`/`mitm`/`clash_general`). A new `sharelink.go` parses the links into `[]Node`. `Assemble` appends `ParseShareLinks(spec.CustomNodes)` to its node list — so both `Generate` and `PreviewTemplate` (which already pass `spec`) pick them up with no further change. No DB migration, no subscription/store/endpoint changes.

**Tech Stack:** Go (`internal/plugins/subgen`, stdlib `net/url`/`encoding/base64`/`encoding/json`), React/TS (`TemplatesTab.tsx`). Spec: `docs/superpowers/specs/2026-05-26-subgen-custom-nodes-design.md`.

**Working directory:** repo root `/Users/hg/project/Shepherd`, branch `feat/subgen-plugin`.

**Conventions:** Run Go from repo root. `go build ./...` leaves no binary (`rm -f server` if one appears). FE gates are `npx tsc --noEmit` + `npx vitest run` from `web/` — do NOT run `npm run build` (it deletes a tracked `.gitkeep`).

---

## File Structure

| File | Change |
|------|--------|
| `internal/plugins/subgen/sharelink.go` | NEW — `ParseShareLinks` + 7 per-protocol parsers |
| `internal/plugins/subgen/sharelink_test.go` | NEW |
| `internal/plugins/subgen/template.go` | add `TemplateSpec.CustomNodes` |
| `internal/plugins/subgen/base.go` | `Assemble` appends parsed custom nodes |
| `internal/plugins/subgen/base_test.go` | assert append |
| `internal/plugins/subgen/service_test.go` | PreviewTemplate includes a custom node (surge + clash) |
| `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx` | `custom_nodes` editor field |
| `docs/subgen.md` | add a "自定义节点" section (doc is Chinese) |

---

## Task 1: Share-link parser (`sharelink.go`)

**Files:**
- Create: `internal/plugins/subgen/sharelink.go`
- Test: `internal/plugins/subgen/sharelink_test.go`

- [ ] **Step 1: Write the failing tests**

Create `internal/plugins/subgen/sharelink_test.go`:

```go
package subgen

import (
	"encoding/base64"
	"testing"
)

func b64raw(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
func b64std(s string) string { return base64.StdEncoding.EncodeToString([]byte(s)) }

func TestParseShareLinks_AllProtocols(t *testing.T) {
	text := "ss://" + b64raw("aes-256-gcm:pass") + "@1.1.1.1:8388#🇭🇰 HK\n" +
		"# a comment\n" +
		"vless://uuid-1@2.2.2.2:443?security=reality&pbk=PBK&sid=SID&flow=xtls-rprx-vision&sni=example.com&type=ws&path=/w&host=v.com#🇺🇸 US\n" +
		"trojan://tjpass@3.3.3.3:443?sni=t.com&type=ws&path=/p&host=h.com&allowInsecure=1#JP\n" +
		"hysteria2://hy2pass@4.4.4.4:443?sni=h2.com&insecure=1#HY2\n" +
		"tuic://uuid-2:tpass@5.5.5.5:443?congestion_control=bbr&sni=tu.com#TUIC\n" +
		"anytls://atpass@6.6.6.6:443?sni=at.com#AT\n" +
		"\n" +
		"not-a-link\n"

	nodes, warns := ParseShareLinks(text)
	if len(nodes) != 6 {
		t.Fatalf("want 6 nodes, got %d (%+v)", len(nodes), nodes)
	}
	if len(warns) != 1 {
		t.Fatalf("want 1 warning, got %d (%v)", len(warns), warns)
	}
	by := map[string]Node{}
	for _, n := range nodes {
		by[n.Name] = n
	}

	if ss := by["🇭🇰 HK"]; ss.Protocol != "shadowsocks" || ss.Server != "1.1.1.1" || ss.Port != 8388 || ss.SSMethod != "aes-256-gcm" || ss.Password != "pass" {
		t.Fatalf("ss = %+v", ss)
	}
	if vl := by["🇺🇸 US"]; vl.Protocol != "vless" || vl.UUID != "uuid-1" || vl.SNI != "example.com" || vl.RealityPublicKey != "PBK" || vl.RealityShortID != "SID" || vl.Flow != "xtls-rprx-vision" || vl.Transport != "ws" || vl.Path != "/w" || vl.Host != "v.com" {
		t.Fatalf("vless = %+v", vl)
	}
	if tj := by["JP"]; tj.Protocol != "trojan" || tj.Password != "tjpass" || tj.SNI != "t.com" || tj.Transport != "ws" || tj.Path != "/p" || tj.Host != "h.com" || !tj.Insecure {
		t.Fatalf("trojan = %+v", tj)
	}
	if hy := by["HY2"]; hy.Protocol != "hysteria2" || hy.Password != "hy2pass" || hy.SNI != "h2.com" || !hy.Insecure {
		t.Fatalf("hy2 = %+v", hy)
	}
	if tu := by["TUIC"]; tu.Protocol != "tuic" || tu.UUID != "uuid-2" || tu.Password != "tpass" || tu.SNI != "tu.com" || tu.Extra["congestion_control"] != "bbr" {
		t.Fatalf("tuic = %+v", tu)
	}
	if at := by["AT"]; at.Protocol != "anytls" || at.Password != "atpass" || at.SNI != "at.com" {
		t.Fatalf("anytls = %+v", at)
	}
}

func TestParseShareLinks_VMessAndLegacySS(t *testing.T) {
	vmessJSON := `{"v":"2","ps":"VM","add":"7.7.7.7","port":"443","id":"vm-uuid","net":"ws","host":"vm.com","path":"/p","tls":"tls","sni":"vm.com"}`
	legacy := "ss://" + b64std("aes-128-gcm:pw@8.8.8.8:8388") + "#LEG"

	nodes, warns := ParseShareLinks("vmess://" + b64std(vmessJSON) + "\n" + legacy)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if len(nodes) != 2 {
		t.Fatalf("want 2 nodes, got %d (%+v)", len(nodes), nodes)
	}
	by := map[string]Node{}
	for _, n := range nodes {
		by[n.Name] = n
	}
	if vm := by["VM"]; vm.Protocol != "vmess" || vm.Server != "7.7.7.7" || vm.Port != 443 || vm.UUID != "vm-uuid" || vm.Transport != "ws" || vm.Path != "/p" || vm.Host != "vm.com" || vm.SNI != "vm.com" {
		t.Fatalf("vmess = %+v", vm)
	}
	if leg := by["LEG"]; leg.Protocol != "shadowsocks" || leg.Server != "8.8.8.8" || leg.Port != 8388 || leg.SSMethod != "aes-128-gcm" || leg.Password != "pw" {
		t.Fatalf("legacy ss = %+v", leg)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/plugins/subgen/ -run TestParseShareLinks`
Expected: FAIL — build error `undefined: ParseShareLinks`.

- [ ] **Step 3: Create `sharelink.go`**

```go
package subgen

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// ParseShareLinks parses newline-separated proxy share links into Nodes. Blank
// lines and lines beginning with '#' are skipped. Unparseable or unsupported
// lines are skipped and reported in warnings (one per bad line). Warnings never
// echo the offending line, which may contain credentials.
func ParseShareLinks(text string) ([]Node, []string) {
	var nodes []Node
	var warns []string
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		n, err := parseShareLink(line)
		if err != nil {
			warns = append(warns, err.Error())
			continue
		}
		nodes = append(nodes, n)
	}
	return nodes, warns
}

func parseShareLink(line string) (Node, error) {
	switch {
	case strings.HasPrefix(line, "ss://"):
		return parseSS(line)
	case strings.HasPrefix(line, "vmess://"):
		return parseVMess(line)
	case strings.HasPrefix(line, "vless://"):
		return parseURINode(line, "vless")
	case strings.HasPrefix(line, "trojan://"):
		return parseURINode(line, "trojan")
	case strings.HasPrefix(line, "hysteria2://"), strings.HasPrefix(line, "hy2://"):
		return parseURINode(line, "hysteria2")
	case strings.HasPrefix(line, "tuic://"):
		return parseURINode(line, "tuic")
	case strings.HasPrefix(line, "anytls://"):
		return parseURINode(line, "anytls")
	default:
		return Node{}, fmt.Errorf("unsupported or unparseable share link")
	}
}

// splitFragment removes a trailing #fragment, returning (rest, decodedName).
// PathUnescape preserves '+' (unlike query unescaping); on error the raw
// fragment is used.
func splitFragment(s string) (string, string) {
	i := strings.LastIndex(s, "#")
	if i < 0 {
		return s, ""
	}
	name := s[i+1:]
	if dec, err := url.PathUnescape(name); err == nil {
		name = dec
	}
	return s[:i], name
}

func nameOr(name, server string, port int) string {
	if name != "" {
		return name
	}
	return server + ":" + strconv.Itoa(port)
}

// b64decode tries the common base64 variants used by share links.
func b64decode(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{
		base64.RawURLEncoding, base64.URLEncoding,
		base64.RawStdEncoding, base64.StdEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, fmt.Errorf("invalid base64")
}

func parseSS(line string) (Node, error) {
	rest, name := splitFragment(strings.TrimPrefix(line, "ss://"))
	if i := strings.Index(rest, "?"); i >= 0 { // drop ?plugin=…
		rest = rest[:i]
	}
	var method, password, hostport string
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		// SIP002: base64(method:password)@host:port
		mp := rest[:at]
		if dec, err := b64decode(mp); err == nil {
			mp = string(dec)
		}
		ci := strings.Index(mp, ":")
		if ci < 0 {
			return Node{}, fmt.Errorf("ss: bad method:password")
		}
		method, password = mp[:ci], mp[ci+1:]
		hostport = rest[at+1:]
	} else {
		// legacy: base64(method:password@host:port)
		dec, err := b64decode(rest)
		if err != nil {
			return Node{}, fmt.Errorf("ss: invalid base64")
		}
		full := string(dec)
		at2 := strings.LastIndex(full, "@")
		if at2 < 0 {
			return Node{}, fmt.Errorf("ss: bad legacy format")
		}
		mp := full[:at2]
		ci := strings.Index(mp, ":")
		if ci < 0 {
			return Node{}, fmt.Errorf("ss: bad method:password")
		}
		method, password = mp[:ci], mp[ci+1:]
		hostport = full[at2+1:]
	}
	host, port, err := splitHostPort(hostport)
	if err != nil {
		return Node{}, fmt.Errorf("ss: %v", err)
	}
	return Node{
		Protocol: "shadowsocks", Server: host, Port: port,
		SSMethod: method, Password: password, Name: nameOr(name, host, port),
	}, nil
}

func parseVMess(line string) (Node, error) {
	dec, err := b64decode(strings.TrimPrefix(line, "vmess://"))
	if err != nil {
		return Node{}, fmt.Errorf("vmess: invalid base64")
	}
	var j struct {
		PS   string `json:"ps"`
		Add  string `json:"add"`
		Port any    `json:"port"`
		ID   string `json:"id"`
		Net  string `json:"net"`
		Host string `json:"host"`
		Path string `json:"path"`
		TLS  string `json:"tls"`
		SNI  string `json:"sni"`
	}
	if err := json.Unmarshal(dec, &j); err != nil {
		return Node{}, fmt.Errorf("vmess: bad json")
	}
	port := toInt(j.Port)
	if j.Add == "" || port == 0 {
		return Node{}, fmt.Errorf("vmess: missing add/port")
	}
	n := Node{Protocol: "vmess", Server: j.Add, Port: port, UUID: j.ID, Name: j.PS}
	if j.Net == "ws" {
		n.Transport = "ws"
		n.Path = j.Path
		n.Host = j.Host
	}
	if j.TLS == "tls" {
		if n.SNI = j.SNI; n.SNI == "" {
			n.SNI = j.Host
		}
	}
	n.Name = nameOr(n.Name, n.Server, port)
	return n, nil
}

func toInt(v any) int {
	switch t := v.(type) {
	case float64:
		return int(t)
	case string:
		n, _ := strconv.Atoi(t)
		return n
	}
	return 0
}

func parseURINode(line, proto string) (Node, error) {
	body, name := splitFragment(line)
	u, err := url.Parse(body)
	if err != nil {
		return Node{}, fmt.Errorf("%s: parse error", proto)
	}
	host := u.Hostname()
	port, err := strconv.Atoi(u.Port())
	if err != nil || host == "" {
		return Node{}, fmt.Errorf("%s: missing host/port", proto)
	}
	q := u.Query()
	n := Node{Protocol: proto, Server: host, Port: port, Name: nameOr(name, host, port)}
	switch proto {
	case "vless":
		n.UUID = u.User.Username()
		n.Flow = q.Get("flow")
		n.SNI = q.Get("sni")
		if q.Get("security") == "reality" {
			n.RealityPublicKey = q.Get("pbk")
			n.RealityShortID = q.Get("sid")
		}
		if q.Get("type") == "ws" {
			n.Transport = "ws"
			n.Path = q.Get("path")
			n.Host = q.Get("host")
		}
	case "trojan":
		n.Password = u.User.Username()
		if n.SNI = q.Get("sni"); n.SNI == "" {
			n.SNI = q.Get("peer")
		}
		if q.Get("type") == "ws" {
			n.Transport = "ws"
			n.Path = q.Get("path")
			n.Host = q.Get("host")
		}
		n.Insecure = q.Get("allowInsecure") == "1"
	case "hysteria2":
		n.Password = u.User.Username()
		n.SNI = q.Get("sni")
		n.Insecure = q.Get("insecure") == "1"
	case "tuic":
		n.UUID = u.User.Username()
		n.Password, _ = u.User.Password()
		n.SNI = q.Get("sni")
		if cc := q.Get("congestion_control"); cc != "" {
			n.Extra = map[string]any{"congestion_control": cc}
		}
	case "anytls":
		n.Password = u.User.Username()
		n.SNI = q.Get("sni")
		n.Insecure = q.Get("insecure") == "1"
	}
	return n, nil
}

// splitHostPort handles IPv4/host and bracketed IPv6, returning host + numeric port.
func splitHostPort(hp string) (string, int, error) {
	host, ps, err := net.SplitHostPort(hp)
	if err != nil {
		return "", 0, fmt.Errorf("bad host:port")
	}
	port, err := strconv.Atoi(ps)
	if err != nil {
		return "", 0, fmt.Errorf("bad port")
	}
	return host, port, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/ -run TestParseShareLinks`
Expected: PASS (both tests).

- [ ] **Step 5: gofmt + commit**

Run: `gofmt -l internal/plugins/subgen/sharelink.go internal/plugins/subgen/sharelink_test.go` → no output.

```bash
git add internal/plugins/subgen/sharelink.go internal/plugins/subgen/sharelink_test.go
git commit -m "feat(subgen): parse proxy share links into Nodes"
```

---

## Task 2: `TemplateSpec.CustomNodes` + `Assemble` append

**Files:**
- Modify: `internal/plugins/subgen/template.go` (struct), `internal/plugins/subgen/base.go` (`Assemble`)
- Test: `internal/plugins/subgen/base_test.go`, `internal/plugins/subgen/service_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `internal/plugins/subgen/base_test.go`:

```go
func TestAssemble_AppendsCustomNodes(t *testing.T) {
	spec := TemplateSpec{
		Final:       "PROXY",
		CustomNodes: "trojan://pw@9.9.9.9:443?sni=x.com#🌟 Custom",
	}
	im := Assemble(nil, spec)
	found := false
	for _, n := range im.Nodes {
		if n.Name == "🌟 Custom" && n.Protocol == "trojan" && n.Server == "9.9.9.9" {
			found = true
		}
	}
	if !found {
		t.Fatalf("custom node not appended: %+v", im.Nodes)
	}
}
```

Append to `internal/plugins/subgen/service_test.go`:

```go
func TestService_PreviewTemplate_CustomNodes(t *testing.T) {
	svc := &Service{Now: time.Now, RulesetBase: DefaultRulesetBase}
	rules := `{"final":"PROXY","custom_nodes":"trojan://pw@9.9.9.9:443?sni=x.com#MyNode"}`
	for _, target := range []string{"surge", "clash"} {
		out, _, err := svc.PreviewTemplate(rules, target)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		if !strings.Contains(out, "MyNode") {
			t.Fatalf("%s preview missing custom node:\n%s", target, out)
		}
	}
}
```

(`service_test.go` already imports `strings`, `time`, `testing`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/plugins/subgen/ -run 'TestAssemble_AppendsCustomNodes|TestService_PreviewTemplate_CustomNodes'`
Expected: FAIL — build error (`spec.CustomNodes` undefined), then assertion failures.

- [ ] **Step 3: Add the `CustomNodes` field**

In `internal/plugins/subgen/template.go`, add to the `TemplateSpec` struct (after `ClashGeneral`):

```go
	CustomNodes string `json:"custom_nodes,omitempty"` // newline-separated proxy share links
```

(Do NOT add validation for it in `ParseTemplate` — it is best-effort free text.)

- [ ] **Step 4: Append parsed custom nodes in `Assemble`**

In `internal/plugins/subgen/base.go`, at the very start of `Assemble` (before the `im := Intermediate{...}` line), insert:

```go
	if custom, _ := ParseShareLinks(spec.CustomNodes); len(custom) > 0 {
		nodes = append(nodes, custom...)
	}
```

So the function begins:

```go
func Assemble(nodes []Node, spec TemplateSpec) Intermediate {
	if custom, _ := ParseShareLinks(spec.CustomNodes); len(custom) > 0 {
		nodes = append(nodes, custom...)
	}
	im := Intermediate{Nodes: nodes, General: spec.General, MITM: spec.MITM, ClashGeneral: spec.ClashGeneral}
	// ... rest unchanged ...
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/`
Expected: PASS (new tests + all existing — `TestAssemble_GroupsAndRules` and `TestService_PreviewTemplate` use no `custom_nodes`, so `ParseShareLinks("")` returns nil and behavior is unchanged).

- [ ] **Step 6: gofmt + commit**

Run: `gofmt -l internal/plugins/subgen/` → no output.

```bash
git add internal/plugins/subgen/template.go internal/plugins/subgen/base.go internal/plugins/subgen/base_test.go internal/plugins/subgen/service_test.go
git commit -m "feat(subgen): merge template custom-node share links into Assemble"
```

---

## Task 3: Editor field (`TemplatesTab.tsx`)

**Files:**
- Modify: `web/src/pages/admin/plugins/subgen/TemplatesTab.tsx`

- [ ] **Step 1: Add `custom_nodes` to `RulesModel`**

Change:
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
  custom_nodes: string
}
```

- [ ] **Step 2: Update `parseRules`**

Add after the `clash_general: String(raw.clash_general ?? ''),` line:
```tsx
    custom_nodes: String(raw.custom_nodes ?? ''),
```

- [ ] **Step 3: Add editor state**

In `TemplateEditor`, add after the `const [clashGeneral, setClashGeneral] = useState(initial.clash_general)` line:
```tsx
  const [customNodes, setCustomNodes] = useState(initial.custom_nodes)
```

- [ ] **Step 4: Update `buildModel`**

Add after the `clash_general: clashGeneral,` line:
```tsx
    custom_nodes: customNodes,
```

- [ ] **Step 5: Update `switchToForm`**

Add after the `setClashGeneral(m.clash_general)` line:
```tsx
    setCustomNodes(m.custom_nodes)
```

- [ ] **Step 6: Add the textarea**

Immediately after the `[Clash] general` textarea's closing `</div>` (the block whose textarea has `placeholder="mode: rule"`), insert:
```tsx
                <div>
                  <Label className="text-[12px]">Custom nodes (share links)</Label>
                  <p className="text-fg-dim text-[11px] mt-0.5 mb-1">
                    One proxy share link per line (<code>vless://</code>, <code>ss://</code>, <code>vmess://</code>, <code>trojan://</code>, <code>hysteria2://</code>, <code>tuic://</code>, <code>anytls://</code>). The name after <code>#</code> becomes the node name; parsed nodes appear in the preview.
                  </p>
                  <textarea
                    value={customNodes}
                    onChange={(e) => setCustomNodes(e.target.value)}
                    rows={4}
                    spellCheck={false}
                    className="w-full px-2 py-1.5 rounded-md border bg-background text-[12px] font-mono"
                    placeholder="vless://uuid@host:443?security=reality&pbk=...#🇺🇸 US"
                  />
                </div>
```

- [ ] **Step 7: Typecheck + tests**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run`
Expected: tsc clean; vitest all pass. Then `cd /Users/hg/project/Shepherd`.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/admin/plugins/subgen/TemplatesTab.tsx
git commit -m "feat(subgen): custom-nodes share-link field in template editor"
```

---

## Task 4: Usage doc (`docs/subgen.md`)

**Files:**
- Modify: `docs/subgen.md` (the doc is in Chinese)

- [ ] **Step 1: Add the section**

In `docs/subgen.md`, insert this new section immediately AFTER the `## 模板` section (i.e., right before the `## 按格式区分的段落` heading):

```markdown
## 自定义节点（分享链接）

模板里可以贴入**自定义节点** —— 每行一条分享链接，会被解析成节点，并与订阅选中的入站节点合并（一起进分组/分流，Surge 与 Clash 都会渲染）。支持 `vless://`、`ss://`、`vmess://`、`trojan://`、`hysteria2://`（或 `hy2://`）、`tuic://`、`anytls://`。链接 `#` 之后的名称作为节点名。在模板编辑器的 **Custom nodes (share links)** 文本框粘贴即可——解析成功的节点会立刻出现在实时预览里（没出现就说明那行没解析成功）。

注意：自定义节点属于**模板**，使用同一模板的所有订阅会共享这批节点。

```

- [ ] **Step 2: Verify fences + commit**

Run: `grep -c '^## ' docs/subgen.md`
Expected: one more `##` heading than before (the new section added).

```bash
git add docs/subgen.md
git commit -m "docs(subgen): document custom nodes (share links)"
```

---

## Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Go build + tests + lint**

Run (repo root): `go build ./... && go test ./... && gofmt -l internal/plugins/subgen/ && go vet ./internal/plugins/subgen/`
Expected: build clean; all packages `ok`; no gofmt output; vet clean. `rm -f server` if a stray binary appears.

- [ ] **Step 2: Frontend gates**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run && cd /Users/hg/project/Shepherd`
Expected: tsc clean; vitest all pass.

- [ ] **Step 3: Confirm clean tree**

Run: `git status --short`
Expected: clean (restore `internal/web/dist/.gitkeep` with `git checkout -- internal/web/dist/.gitkeep` if a build removed it).

---

## Self-Review (completed by plan author)

**Spec coverage:**
- `sharelink.go` `ParseShareLinks` + 7 parsers (ss SIP002+legacy, vmess base64-JSON, vless/trojan/hysteria2/tuic/anytls URIs), `#fragment`→name, bad-line warnings → Task 1. ✓
- `TemplateSpec.CustomNodes` (no validation) → Task 2. ✓
- `Assemble` appends `ParseShareLinks(spec.CustomNodes)`; `Generate`/`PreviewTemplate` unchanged → Task 2. ✓
- Editor field mirroring `clash_general` → Task 3. ✓
- Usage doc → Task 4. ✓
- Tests: parser table + vmess/legacy-ss, Assemble append, PreviewTemplate surge+clash → Tasks 1-2. ✓
- No migration / no subscription-store-endpoint changes → inherent (nothing in the plan touches them). ✓

**Placeholder scan:** none — every code step is complete.

**Type/name consistency:** `ParseShareLinks(text string) ([]Node, []string)`, helpers `splitFragment`/`nameOr`/`b64decode`/`toInt`/`splitHostPort`/`parseSS`/`parseVMess`/`parseURINode`, `Node` fields (Protocol/Server/Port/SSMethod/Password/UUID/SNI/Flow/RealityPublicKey/RealityShortID/Transport/Path/Host/Insecure/Extra/Name), `TemplateSpec.CustomNodes` (Go) and `custom_nodes`/`customNodes` (TS) used consistently. `Assemble` keeps its `(nodes, spec)` signature; the append uses the same `nodes` variable the `Intermediate` is built from.
