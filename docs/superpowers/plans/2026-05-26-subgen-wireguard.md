# WireGuard Node Support (`wg://`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse WireGuard `wg://`/`wireguard://` share links into the unified `Node` model (fields in `Node.Extra`) and render them in Clash (`type: wireguard`), Surge (`[WireGuard]` section), and ShadowRocket (inline `[Proxy]` line).

**Architecture:** A new `parseWireGuard` in `sharelink.go` stores WG fields in `Node.Extra`. `clashProxy` gains a `wireguard` case. The Surge renderer's `Render` is factored into a shared `render(im, subURL, rulesetBase, wgInline bool)`; Surge (`wgInline=false`) emits a `[WireGuard wgN]` section + a `section-name` proxy reference, while `ShadowRocketRenderer` overrides `Render` to pass `wgInline=true` for an inline proxy line. Non-WG output is unchanged.

**Tech Stack:** Go (`internal/plugins/subgen`, stdlib `net/url`/`strconv`), `gopkg.in/yaml.v3`. Spec: `docs/superpowers/specs/2026-05-26-subgen-wireguard-design.md`.

**Working directory:** repo root `/Users/hg/project/Shepherd`, branch `feat/subgen-plugin`.

**Conventions:** Run Go from repo root. `go build ./...` leaves no binary (`rm -f server` if one appears). FE not touched. gofmt-clean every file.

---

## File Structure

| File | Change |
|------|--------|
| `internal/plugins/subgen/sharelink.go` | `wg://`/`wireguard://` dispatch + `parseWireGuard` + `firstNonEmpty`/`withFlag` helpers |
| `internal/plugins/subgen/sharelink_test.go` | WG parse test |
| `internal/plugins/subgen/render_clash.go` | `Supports` + `clashProxy` wireguard case + `wgField`/`wgIPCIDR`/`wgReserved` helpers |
| `internal/plugins/subgen/render_clash_test.go` | Clash WG test |
| `internal/plugins/subgen/render_surge.go` | `Supports` + `Render`→`render(…, wgInline)` refactor + `surgeWGSection`/`shadowrocketWGLine` |
| `internal/plugins/subgen/render_shadowrocket.go` | override `Render` (wgInline=true) |
| `internal/plugins/subgen/render_surge_test.go` | Surge WG test |
| `internal/plugins/subgen/render_shadowrocket_test.go` | ShadowRocket WG test |
| `docs/subgen.md` | add `wg://` to the custom-nodes protocol list |

---

## Task 1: Parse `wg://` share links

**Files:**
- Modify: `internal/plugins/subgen/sharelink.go`
- Test: `internal/plugins/subgen/sharelink_test.go`

- [ ] **Step 1: Write the failing test**

Add to the imports of `internal/plugins/subgen/sharelink_test.go` (it currently imports `encoding/base64`, `testing`): add `net/url`. Then append:

```go
func TestParseShareLinks_WireGuard(t *testing.T) {
	link := "wg://home.hg.ht:51820?publicKey=" + url.QueryEscape("PUB+KEY=") +
		"&privateKey=" + url.QueryEscape("PRIV+KEY=") +
		"&presharedKey=" + url.QueryEscape("PSK+=") +
		"&ip=10.254.253.3&udp=1&reserved=0,0,0&flag=CN#WG"

	nodes, warns := ParseShareLinks(link)
	if len(warns) != 0 || len(nodes) != 1 {
		t.Fatalf("nodes=%d warns=%v", len(nodes), warns)
	}
	n := nodes[0]
	if n.Protocol != "wireguard" || n.Server != "home.hg.ht" || n.Port != 51820 {
		t.Fatalf("endpoint = %+v", n)
	}
	if n.Name != "🇨🇳 WG" {
		t.Fatalf("name = %q", n.Name)
	}
	if n.Extra["private_key"] != "PRIV+KEY=" || n.Extra["public_key"] != "PUB+KEY=" || n.Extra["preshared_key"] != "PSK+=" {
		t.Fatalf("keys = %+v", n.Extra)
	}
	if n.Extra["ip"] != "10.254.253.3" || n.Extra["reserved"] != "0,0,0" || n.Extra["udp"] != true {
		t.Fatalf("extra = %+v", n.Extra)
	}

	// missing keys → warning, skipped
	if ns, ws := ParseShareLinks("wg://h:1?ip=1.2.3.4#X"); len(ns) != 0 || len(ws) != 1 {
		t.Fatalf("missing-keys: nodes=%d warns=%d", len(ns), len(ws))
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestParseShareLinks_WireGuard`
Expected: FAIL — `wg://` falls into the default case (returns "unsupported" warning), so 0 nodes / 1 warning for the first link → assertion fails.

- [ ] **Step 3: Add dispatch + parser**

In `internal/plugins/subgen/sharelink.go`, add a case to `parseShareLink`'s switch, immediately before `default:`:

```go
	case strings.HasPrefix(line, "wireguard://"), strings.HasPrefix(line, "wg://"):
		return parseWireGuard(line)
```

Then add these functions at the end of the file:

```go
func parseWireGuard(line string) (Node, error) {
	body, name := splitFragment(line)
	u, err := url.Parse(body)
	if err != nil {
		return Node{}, fmt.Errorf("wireguard: parse error")
	}
	host := u.Hostname()
	port, err := strconv.Atoi(u.Port())
	if err != nil || host == "" {
		return Node{}, fmt.Errorf("wireguard: missing host/port")
	}
	q := u.Query()
	priv := firstNonEmpty(q.Get("privateKey"), q.Get("private_key"))
	pub := firstNonEmpty(q.Get("publicKey"), q.Get("public_key"))
	if priv == "" || pub == "" {
		return Node{}, fmt.Errorf("wireguard: missing keys")
	}
	extra := map[string]any{
		"private_key": priv,
		"public_key":  pub,
		"udp":         q.Get("udp") != "0",
	}
	if psk := firstNonEmpty(q.Get("presharedKey"), q.Get("preshared_key")); psk != "" {
		extra["preshared_key"] = psk
	}
	if ip := firstNonEmpty(q.Get("ip"), q.Get("address")); ip != "" {
		extra["ip"] = ip
	}
	if res := q.Get("reserved"); res != "" {
		extra["reserved"] = res
	}
	if m := q.Get("mtu"); m != "" {
		if mtu, err := strconv.Atoi(m); err == nil {
			extra["mtu"] = mtu
		}
	}
	return Node{
		Protocol: "wireguard", Server: host, Port: port,
		Name: nameOr(withFlag(q.Get("flag"), name), host, port), Extra: extra,
	}, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// withFlag prepends the country-flag emoji (from a 2-letter code) to name.
func withFlag(flag, name string) string {
	f := countryFlag(flag)
	if f == "" {
		return name
	}
	if name == "" {
		return f
	}
	return f + " " + name
}
```

(`sharelink.go` already imports `fmt`, `net/url`, `strconv`, `strings`. `splitFragment`, `nameOr` are already defined there; `countryFlag` is in `node.go`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run TestParseShareLinks_WireGuard`
Expected: PASS.

- [ ] **Step 5: gofmt + commit**

Run: `gofmt -l internal/plugins/subgen/sharelink.go internal/plugins/subgen/sharelink_test.go` → no output.

```bash
git add internal/plugins/subgen/sharelink.go internal/plugins/subgen/sharelink_test.go
git commit -m "feat(subgen): parse wg:// WireGuard share links"
```

---

## Task 2: Clash WireGuard rendering

**Files:**
- Modify: `internal/plugins/subgen/render_clash.go`
- Test: `internal/plugins/subgen/render_clash_test.go`

- [ ] **Step 1: Write the failing test**

Append to `internal/plugins/subgen/render_clash_test.go`:

```go
func TestClash_WireGuard(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "🇨🇳 WG", Protocol: "wireguard", Server: "home.hg.ht", Port: 51820,
			Extra: map[string]any{
				"private_key": "PRIV", "public_key": "PUB", "preshared_key": "PSK",
				"ip": "10.254.253.3", "reserved": "0,0,0", "udp": true,
			},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"🇨🇳 WG"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ClashRenderer{}).Render(im, "", DefaultRulesetBase)
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(out), &doc); err != nil {
		t.Fatalf("invalid yaml: %v\n%s", err, out)
	}
	for _, want := range []string{
		"type: wireguard", "private-key: PRIV", "public-key: PUB",
		"pre-shared-key: PSK", "ip: 10.254.253.3/32", "udp: true", "reserved:",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("clash WG missing %q\n%s", want, out)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./internal/plugins/subgen/ -run TestClash_WireGuard`
Expected: FAIL — `clashProxy` returns nil for `wireguard` (default case), so the proxy is dropped and none of the substrings appear.

- [ ] **Step 3: Implement**

In `internal/plugins/subgen/render_clash.go`:

(a) Add `"wireguard"` to `Supports`:
```go
func (*ClashRenderer) Supports(p string) bool {
	switch p {
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls", "wireguard":
		return true
	}
	return false
}
```

(b) In `clashProxy`, add a case before `default:`:
```go
	case "wireguard":
		p["type"] = "wireguard"
		p["private-key"] = wgField(n, "private_key")
		p["public-key"] = wgField(n, "public_key")
		if psk := wgField(n, "preshared_key"); psk != "" {
			p["pre-shared-key"] = psk
		}
		if ip := wgField(n, "ip"); ip != "" {
			p["ip"] = wgIPCIDR(ip)
		}
		p["allowed-ips"] = []string{"0.0.0.0/0", "::/0"}
		if res := wgReserved(wgField(n, "reserved")); res != nil {
			p["reserved"] = res
		}
		if mtu, ok := n.Extra["mtu"].(int); ok && mtu > 0 {
			p["mtu"] = mtu
		}
		p["udp"] = true
```

(c) Add helpers at the end of the file:
```go
// wgField reads a WireGuard string field from Node.Extra.
func wgField(n Node, key string) string {
	s, _ := n.Extra[key].(string)
	return s
}

// wgIPCIDR ensures the WireGuard self-ip has a CIDR mask (mihomo expects one).
func wgIPCIDR(ip string) string {
	if strings.Contains(ip, "/") {
		return ip
	}
	return ip + "/32"
}

// wgReserved parses a "a,b,c" reserved string into a 3-element []int, or nil.
func wgReserved(s string) []int {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	if len(parts) != 3 {
		return nil
	}
	out := make([]int, 0, 3)
	for _, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil {
			return nil
		}
		out = append(out, v)
	}
	return out
}
```

Add `"strconv"` to `render_clash.go`'s import block (currently `strings` + `gopkg.in/yaml.v3`).

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./internal/plugins/subgen/ -run TestClash_WireGuard`
Expected: PASS.

- [ ] **Step 5: gofmt + commit**

Run: `gofmt -l internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_clash_test.go` → no output.

```bash
git add internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_clash_test.go
git commit -m "feat(subgen): Clash wireguard proxy rendering"
```

---

## Task 3: Surge + ShadowRocket WireGuard rendering

**Files:**
- Modify: `internal/plugins/subgen/render_surge.go`, `internal/plugins/subgen/render_shadowrocket.go`
- Test: `internal/plugins/subgen/render_surge_test.go`, `internal/plugins/subgen/render_shadowrocket_test.go`

- [ ] **Step 1: Write the failing tests**

Append to `internal/plugins/subgen/render_surge_test.go`:

```go
func TestSurge_WireGuard(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "🇨🇳 WG", Protocol: "wireguard", Server: "home.hg.ht", Port: 51820,
			Extra: map[string]any{"private_key": "PRIV", "public_key": "PUB", "preshared_key": "PSK", "ip": "10.254.253.3", "reserved": "0,0,0", "udp": true},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"🇨🇳 WG"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&SurgeRenderer{}).Render(im, "https://x?target=surge", DefaultRulesetBase)
	for _, want := range []string{
		"🇨🇳 WG = wireguard, section-name=wg0",
		"[WireGuard wg0]",
		"private-key = PRIV",
		"self-ip = 10.254.253.3",
		`peer = (public-key = PUB, allowed-ips = "0.0.0.0/0, ::/0", endpoint = home.hg.ht:51820, preshared-key = PSK)`,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("surge WG missing %q\n%s", want, out)
		}
	}
	if strings.Contains(out, "reserved") {
		t.Errorf("surge should drop reserved\n%s", out)
	}
}
```

Append to `internal/plugins/subgen/render_shadowrocket_test.go`:

```go
func TestShadowRocket_WireGuard(t *testing.T) {
	im := Intermediate{
		Nodes: []Node{{
			Name: "🇨🇳 WG", Protocol: "wireguard", Server: "home.hg.ht", Port: 51820,
			Extra: map[string]any{"private_key": "PRIV", "public_key": "PUB", "preshared_key": "PSK", "ip": "10.254.253.3", "reserved": "0,0,0", "udp": true},
		}},
		Groups: []Group{{Name: "PROXY", Type: "select", Members: []string{"🇨🇳 WG"}}},
		Rules:  []Rule{{Final: true, Target: "PROXY"}},
	}
	out := (&ShadowRocketRenderer{}).Render(im, "https://x?target=shadowrocket", DefaultRulesetBase)
	want := "🇨🇳 WG = wireguard, home.hg.ht, 51820, privateKey=PRIV, publicKey=PUB, ip=10.254.253.3, udp=1, presharedKey=PSK, reserved=0/0/0"
	if !strings.Contains(out, want) {
		t.Fatalf("shadowrocket missing inline WG line:\n%s", out)
	}
	if strings.Contains(out, "[WireGuard") {
		t.Fatalf("shadowrocket must NOT emit a [WireGuard] section:\n%s", out)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./internal/plugins/subgen/ -run 'TestSurge_WireGuard|TestShadowRocket_WireGuard'`
Expected: FAIL — `Supports("wireguard")` is false so the WG node is skipped; the expected lines don't appear.

- [ ] **Step 3: Add `wireguard` to Surge `Supports`**

In `internal/plugins/subgen/render_surge.go`:
```go
func (*SurgeRenderer) Supports(p string) bool {
	switch p {
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls", "wireguard":
		return true
	}
	return false
}
```

- [ ] **Step 4: Refactor `Render` → `render(…, wgInline)` with WG handling**

In `internal/plugins/subgen/render_surge.go`, replace the whole `Render` method with these two functions:

```go
func (r *SurgeRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, false)
}

// render builds the Surge-family .conf. wgInline selects WireGuard handling:
// false → a [WireGuard <section>] block + a section-name proxy reference (Surge);
// true → a single inline [Proxy] line (ShadowRocket).
func (r *SurgeRenderer) render(im Intermediate, subURL, rulesetBase string, wgInline bool) string {
	var b strings.Builder
	fmt.Fprintf(&b, "#!MANAGED-CONFIG %s interval=43200 strict=false\n\n", subURL)

	var skipped []string
	for _, n := range im.Nodes {
		if !r.Supports(n.Protocol) {
			skipped = append(skipped, n.Name)
		}
	}
	if len(skipped) > 0 {
		fmt.Fprintf(&b, "# skipped %d node(s) not supported by surge: %s\n", len(skipped), strings.Join(skipped, ", "))
	}

	b.WriteString("[General]\n")
	if g := strings.TrimSpace(im.General); g != "" {
		b.WriteString(g + "\n\n")
	} else {
		b.WriteString("bypass-system = true\n\n")
	}

	b.WriteString("[Proxy]\nDIRECT = direct\n")
	type wgSec struct {
		n   Node
		sec string
	}
	var wgSecs []wgSec
	for _, n := range im.Nodes {
		if !r.Supports(n.Protocol) {
			continue
		}
		if n.Protocol == "wireguard" {
			if wgInline {
				b.WriteString(shadowrocketWGLine(n) + "\n")
			} else {
				sec := fmt.Sprintf("wg%d", len(wgSecs))
				fmt.Fprintf(&b, "%s = wireguard, section-name=%s\n", n.Name, sec)
				wgSecs = append(wgSecs, wgSec{n, sec})
			}
			continue
		}
		b.WriteString(r.proxyLine(n) + "\n")
	}

	b.WriteString("\n[Proxy Group]\n")
	for _, g := range im.Groups {
		b.WriteString(r.groupLine(g) + "\n")
	}
	b.WriteString("\n[Rule]\n")
	for _, rule := range im.Rules {
		b.WriteString(surgeRuleLine(rule, rulesetBase) + "\n")
	}
	if m := strings.TrimSpace(im.MITM); m != "" {
		b.WriteString("\n[MITM]\n" + m + "\n")
	}
	for _, w := range wgSecs {
		b.WriteString("\n" + surgeWGSection(w.n, w.sec))
	}
	return b.String()
}
```

- [ ] **Step 5: Add the WG line/section helpers**

Append to `internal/plugins/subgen/render_surge.go`:

```go
// surgeWGSection renders a Surge [WireGuard <sec>] block. reserved has no Surge
// field and is dropped.
func surgeWGSection(n Node, sec string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[WireGuard %s]\n", sec)
	fmt.Fprintf(&b, "private-key = %s\n", wgField(n, "private_key"))
	if ip := wgField(n, "ip"); ip != "" {
		fmt.Fprintf(&b, "self-ip = %s\n", ip)
	}
	if mtu, ok := n.Extra["mtu"].(int); ok && mtu > 0 {
		fmt.Fprintf(&b, "mtu = %d\n", mtu)
	}
	fmt.Fprintf(&b, `peer = (public-key = %s, allowed-ips = "0.0.0.0/0, ::/0", endpoint = %s:%d`, wgField(n, "public_key"), n.Server, n.Port)
	if psk := wgField(n, "preshared_key"); psk != "" {
		b.WriteString(", preshared-key = " + psk)
	}
	b.WriteString(")\n")
	return b.String()
}

// shadowrocketWGLine renders a ShadowRocket inline [Proxy] WireGuard line.
func shadowrocketWGLine(n Node) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s = wireguard, %s, %d, privateKey=%s, publicKey=%s", n.Name, n.Server, n.Port, wgField(n, "private_key"), wgField(n, "public_key"))
	if ip := wgField(n, "ip"); ip != "" {
		b.WriteString(", ip=" + ip)
	}
	b.WriteString(", udp=1")
	if psk := wgField(n, "preshared_key"); psk != "" {
		b.WriteString(", presharedKey=" + psk)
	}
	if mtu, ok := n.Extra["mtu"].(int); ok && mtu > 0 {
		fmt.Fprintf(&b, ", mtu=%d", mtu)
	}
	if res := wgField(n, "reserved"); res != "" {
		b.WriteString(", reserved=" + strings.ReplaceAll(res, ",", "/"))
	}
	return b.String()
}
```

(`wgField` is defined in `render_clash.go` from Task 2 — same package.)

- [ ] **Step 6: Override `Render` in ShadowRocket**

Replace the whole contents of `internal/plugins/subgen/render_shadowrocket.go` with:

```go
package subgen

// ShadowRocket consumes the Surge .conf syntax, except WireGuard, which it takes
// as an inline [Proxy] line (no [WireGuard] section). It inherits everything from
// SurgeRenderer and overrides only Target() and Render() (the latter to render
// WireGuard inline via wgInline=true).
type ShadowRocketRenderer struct{ SurgeRenderer }

func (*ShadowRocketRenderer) Target() string { return "shadowrocket" }

func (r *ShadowRocketRenderer) Render(im Intermediate, subURL, rulesetBase string) string {
	return r.render(im, subURL, rulesetBase, true)
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `go test ./internal/plugins/subgen/`
Expected: PASS — the new WG tests plus all existing Surge/ShadowRocket tests (non-WG nodes render identically through `render(…, wgInline)`; the existing `TestShadowRocket_RendersAndReportsTarget` and `TestSurge_*` still pass).

- [ ] **Step 8: gofmt + commit**

Run: `gofmt -l internal/plugins/subgen/` → no output.

```bash
git add internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_shadowrocket.go internal/plugins/subgen/render_surge_test.go internal/plugins/subgen/render_shadowrocket_test.go
git commit -m "feat(subgen): Surge [WireGuard] section + ShadowRocket inline wireguard"
```

---

## Task 4: Document `wg://` support

**Files:**
- Modify: `docs/subgen.md`

- [ ] **Step 1: Update the protocol list**

In `docs/subgen.md`, in the `## 自定义节点（分享链接）` section, replace:

```
支持 `vless://`、`ss://`、`vmess://`、`trojan://`、`hysteria2://`（或 `hy2://`）、`tuic://`、`anytls://`。
```

with:

```
支持 `vless://`、`ss://`、`vmess://`、`trojan://`、`hysteria2://`（或 `hy2://`）、`tuic://`、`anytls://`、`wg://`（或 `wireguard://`）。WireGuard 在 Clash 渲染为 `type: wireguard`，在 Surge 渲染为独立 `[WireGuard]` 段，在 ShadowRocket 渲染为内联 `[Proxy]` 行。
```

- [ ] **Step 2: Commit**

```bash
git add docs/subgen.md
git commit -m "docs(subgen): note wg:// WireGuard support"
```

---

## Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Go build + tests + lint**

Run (repo root): `go build ./... && go test ./... && gofmt -l internal/plugins/subgen/ && go vet ./internal/plugins/subgen/`
Expected: build clean; all packages `ok`; no gofmt output; vet clean. `rm -f server` if a stray binary appears.

- [ ] **Step 2: Frontend gates (unchanged, sanity only)**

Run: `cd /Users/hg/project/Shepherd/web && npx tsc --noEmit && npx vitest run && cd /Users/hg/project/Shepherd`
Expected: tsc clean; vitest all pass. (No FE files changed; this just confirms nothing drifted.)

- [ ] **Step 3: Confirm clean tree**

Run: `git status --short`
Expected: clean (restore `internal/web/dist/.gitkeep` with `git checkout -- internal/web/dist/.gitkeep` if a build removed it).

---

## Self-Review (completed by plan author)

**Spec coverage:**
- `wg://`/`wireguard://` parse → `Node.Extra` (private_key/public_key/preshared_key/ip/reserved/mtu/udp), name with flag → Task 1. ✓
- Clash `type: wireguard` (pre-shared-key, ip /32, allowed-ips, reserved []int, udp) → Task 2. ✓
- Surge `[WireGuard wgN]` section + `section-name` proxy ref, reserved dropped → Task 3. ✓
- ShadowRocket inline `[Proxy]` line (no section), reserved comma→slash → Task 3 (render refactor + override). ✓
- Group membership unchanged (WG is an ordinary Node) → no Assemble change. ✓
- Docs → Task 4. ✓
- No `Node` struct change / no migration → inherent (Extra only). ✓

**Placeholder scan:** none — every code step is complete.

**Type/name consistency:** `parseWireGuard`, `firstNonEmpty`, `withFlag` (Task 1, sharelink.go); `wgField`/`wgIPCIDR`/`wgReserved` (Task 2, render_clash.go) reused by Task 3; `surgeWGSection`/`shadowrocketWGLine` + `render(im, subURL, rulesetBase, wgInline bool)` (Task 3). `Node.Extra` keys (`private_key`,`public_key`,`preshared_key`,`ip`,`reserved`,`mtu`,`udp`) are written in Task 1 and read identically in Tasks 2–3. `ShadowRocketRenderer` keeps embedding `SurgeRenderer`; `r.render(...)` resolves to the embedded method with `wgInline=true`.
