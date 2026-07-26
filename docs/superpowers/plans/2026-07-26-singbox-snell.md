# sing-box snell inbound 支持实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Shepherd 能在 sing-box 1.14+ 主机上创建 snell v5/v6 inbound，并把这些节点按各客户端能力渲染进 surge / shadowrocket / clash 订阅。

**Architecture:** 新增两个协议值 `snell-v5`、`snell-v6`（版本写进协议名，与 `tuic-v5` 同风格），psk 复用现有 `password` 列、obfs_mode/mode 走 `extra_json`，零 migration。版本门禁放在部署时（`AssembleAndDeploy`），因为创建 inbound 的校验函数看不到主机版本。订阅侧按客户端能力降级：Surge 写真实版本，Shadowrocket/clash 把 v5 降为 4、把 v6 整个跳过。

**Tech Stack:** Go 1.25（后端，sqlx + net/http）、React 18 + Vite + TS（web）、Expo/React Native（mobile）、vitest / go test。

## Global Constraints

- 仓库根 `/Users/hg/project/Shepherd`；分支 `snell-support`（已从 main 切出，spec 已在其上）。
- 后端验证：`go build ./... && go test -race ./...`（CI 跑 `-race`，普通 `go test` 漏过竞态）、`golangci-lint run`（CI 跑 staticcheck，`go vet`+`gofmt` 覆盖不到）。
- 前端验证：在 `web/` 下 `npm run build && npm test`，以及仓库根 `bash scripts/check-ui-tokens.sh`。
- mobile 验证：在 `mobile/` 下 `npm test`。
- **协议值恰好是** `snell-v5` 与 `snell-v6`（小写，带连字符）。
- **snell 渲染出的 sing-box inbound 字段**：`type: "snell"`、`version: 5|6`（数字非字符串）、`psk`、v5 另有 `obfs_mode`、v6 另有 `mode`。**无 tls、无 transport、无 users 数组**。
- **枚举白名单**：`obfs_mode` ∈ {`none`, `http`}，缺省 `none`；`mode` ∈ {`default`, `unshaped`, `unsafe-raw`}，缺省 `default`。非法值必须渲染时报错，不得透传（1.14 对未知枚举在配置解析阶段 FATAL）。
- **中继出站版本映射**：sing-box snell **outbound** 版本枚举是 `4|6`，**没有 5**。landing 为 `snell-v5` 时出站写 `4`，`snell-v6` 时写 `6`。
- **订阅降级矩阵**：snell-v5 → Surge `version=5` / Shadowrocket `version=4` / clash `version: 4`；snell-v6 → Surge `version=6` / Shadowrocket 跳过 / clash 跳过。
- **不做**：多用户 `users[]`、`snell://` 分享链接、Stash/Loon/Quantumult X 输出、snell 通用出站、升级默认 sing-box 版本。
- PSK 长度不做硬校验（sing-box 文档称 v6 需 12–255 字节，但参考实现 sing-snell 无此校验）；只校验非空。
- 每个任务一个 commit，信息用 `feat(singbox):` / `feat(subgen):` / `feat(web):` / `chore(ci):` 前缀。

---

### Task 1: 后端协议白名单 + 校验

**Files:**
- Modify: `internal/plugins/singbox/inbounds_routes.go:25-37`（`isValidProtocol`）、`:76-126`（`validatePostInbound`）
- Test: `internal/plugins/singbox/inbounds_routes_test.go`

**Interfaces:**
- Produces: `isValidProtocol("snell-v5")` / `isValidProtocol("snell-v6")` 返回 true；`validatePostInbound` 对 snell 协议要求 `password` 非空。

- [ ] **Step 1: 写失败测试**（追加到 `inbounds_routes_test.go`，沿用文件中现有的表驱动/断言风格）：

```go
func TestIsValidProtocol_Snell(t *testing.T) {
	for _, p := range []string{"snell-v5", "snell-v6"} {
		if !isValidProtocol(p) {
			t.Errorf("isValidProtocol(%q) = false, want true", p)
		}
	}
	if isValidProtocol("snell") {
		t.Error(`isValidProtocol("snell") = true, want false (version must be in the name)`)
	}
}

func TestValidatePostInbound_SnellRequiresPassword(t *testing.T) {
	store := newTestInboundStore(t) // 若该 helper 不存在，改用文件里现有的 store 构造方式
	body := postInboundBody{ServerID: 1, Port: 8443, Role: "landing", Protocol: "snell-v5"}
	if err := validatePostInbound(context.Background(), store, body); err == nil {
		t.Fatal("expected error when snell psk (password) is empty")
	}
	psk := "test-psk-value"
	body.Password = &psk
	if err := validatePostInbound(context.Background(), store, body); err != nil {
		t.Fatalf("unexpected error with psk set: %v", err)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/plugins/singbox/ -run 'Snell' -v`
Expected: FAIL（`isValidProtocol` 不认 snell-v5）。

- [ ] **Step 3: 实现**

`isValidProtocol` 的字符串数组末尾追加一行：

```go
		"hysteria2", "tuic-v5", "anytls", "shadowsocks-2022",
		"snell-v5", "snell-v6",
```

`validatePostInbound` 在协议合法性检查之后、端口冲突检查之前插入：

```go
	if body.Protocol == "snell-v5" || body.Protocol == "snell-v6" {
		if body.Password == nil || *body.Password == "" {
			return errors.New("password (snell psk) required for snell inbounds")
		}
	}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/plugins/singbox/ -run 'Snell' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/inbounds_routes.go internal/plugins/singbox/inbounds_routes_test.go
git commit -m "feat(singbox): accept snell-v5/snell-v6 protocols with psk validation"
```

---

### Task 2: snell inbound 渲染

**Files:**
- Modify: `internal/plugins/singbox/render.go:200-240`（`renderInbound` switch）、新增 `renderSnell`（放在 `renderSS2022` 之后）
- Test: `internal/plugins/singbox/render_test.go`

**Interfaces:**
- Consumes: Task 1 的协议值。
- Produces: `renderSnell(base map[string]any, in InboundView, version int) (map[string]any, error)`；`snellObfsMode(extra map[string]any) (string, error)`；`snellMode(extra map[string]any) (string, error)`。

- [ ] **Step 1: 写失败测试**（追加到 `render_test.go`，参照文件里 `TestRender_Hysteria2` 的构造方式）：

```go
func TestRender_SnellV5(t *testing.T) {
	psk := "psk-abc"
	in := InboundView{Inbound: Inbound{
		ServerID: 1, Tag: "landing-snell5", Port: 8443,
		Role: "landing", Protocol: "snell-v5", Password: &psk,
	}}
	got, err := renderInbound(in, nil)
	if err != nil {
		t.Fatalf("renderInbound: %v", err)
	}
	if got["type"] != "snell" {
		t.Errorf("type = %v, want snell", got["type"])
	}
	if got["version"] != 5 {
		t.Errorf("version = %v (%T), want 5 (int)", got["version"], got["version"])
	}
	if got["psk"] != psk {
		t.Errorf("psk = %v, want %v", got["psk"], psk)
	}
	if got["obfs_mode"] != "none" {
		t.Errorf("obfs_mode = %v, want none (default)", got["obfs_mode"])
	}
	if _, ok := got["tls"]; ok {
		t.Error("snell must not carry a tls block")
	}
	if _, ok := got["users"]; ok {
		t.Error("snell must not carry a users array")
	}
}

func TestRender_SnellV5_ObfsHTTP(t *testing.T) {
	psk := "psk-abc"
	extra := `{"obfs_mode":"http"}`
	in := InboundView{Inbound: Inbound{
		ServerID: 1, Tag: "landing-snell5", Port: 8443,
		Role: "landing", Protocol: "snell-v5", Password: &psk, ExtraJSON: &extra,
	}}
	got, err := renderInbound(in, nil)
	if err != nil {
		t.Fatalf("renderInbound: %v", err)
	}
	if got["obfs_mode"] != "http" {
		t.Errorf("obfs_mode = %v, want http", got["obfs_mode"])
	}
}

func TestRender_SnellV6(t *testing.T) {
	psk := "psk-abc"
	extra := `{"mode":"unshaped"}`
	in := InboundView{Inbound: Inbound{
		ServerID: 1, Tag: "landing-snell6", Port: 8443,
		Role: "landing", Protocol: "snell-v6", Password: &psk, ExtraJSON: &extra,
	}}
	got, err := renderInbound(in, nil)
	if err != nil {
		t.Fatalf("renderInbound: %v", err)
	}
	if got["version"] != 6 {
		t.Errorf("version = %v, want 6", got["version"])
	}
	if got["mode"] != "unshaped" {
		t.Errorf("mode = %v, want unshaped", got["mode"])
	}
	if _, ok := got["obfs_mode"]; ok {
		t.Error("v6 must not carry obfs_mode")
	}
}

func TestRender_SnellRejectsBadEnum(t *testing.T) {
	psk := "psk-abc"
	badObfs := `{"obfs_mode":"tls"}`
	in := InboundView{Inbound: Inbound{
		ServerID: 1, Tag: "t", Port: 8443, Role: "landing",
		Protocol: "snell-v5", Password: &psk, ExtraJSON: &badObfs,
	}}
	if _, err := renderInbound(in, nil); err == nil {
		t.Error("expected error for obfs_mode=tls (only none/http allowed)")
	}
	badMode := `{"mode":"turbo"}`
	in.Protocol = "snell-v6"
	in.ExtraJSON = &badMode
	if _, err := renderInbound(in, nil); err == nil {
		t.Error("expected error for mode=turbo")
	}
}
```

> 注：`InboundView`/`Inbound` 的字面量构造方式以 `render_test.go` 现有测试为准（若 `InboundView` 是扁平结构而非嵌入 `Inbound`，按文件现状改写字面量，字段名不变）。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/plugins/singbox/ -run 'TestRender_Snell' -v`
Expected: FAIL，报 `unsupported protocol: snell-v5`。

- [ ] **Step 3: 实现**

`renderInbound` 的 switch 在 `case "shadowsocks-2022":` 之后加两个 case：

```go
	case "snell-v5":
		return renderSnell(base, in, 5)
	case "snell-v6":
		return renderSnell(base, in, 6)
```

在 `renderSS2022` 函数之后新增：

```go
// renderSnell builds a snell inbound. snell has no TLS layer and no
// transport layer; the psk lives in the shared password column and the
// version is carried by the protocol name (snell-v5 / snell-v6).
// Enum values are whitelisted here rather than passed through: sing-box
// 1.14 rejects unknown enum values at config-parse time with a FATAL the
// panel never sees.
func renderSnell(base map[string]any, in InboundView, version int) (map[string]any, error) {
	psk := strVal(in.Password)
	if psk == "" {
		return nil, fmt.Errorf("snell %s: psk (password) is empty", in.Tag)
	}
	base["type"] = "snell"
	base["version"] = version
	base["psk"] = psk

	extra := map[string]any{}
	if in.ExtraJSON != nil && *in.ExtraJSON != "" {
		if err := json.Unmarshal([]byte(*in.ExtraJSON), &extra); err != nil {
			return nil, fmt.Errorf("snell %s: bad extra_json: %w", in.Tag, err)
		}
	}

	if version == 5 {
		m, err := snellObfsMode(extra)
		if err != nil {
			return nil, fmt.Errorf("snell %s: %w", in.Tag, err)
		}
		base["obfs_mode"] = m
		return base, nil
	}
	m, err := snellMode(extra)
	if err != nil {
		return nil, fmt.Errorf("snell %s: %w", in.Tag, err)
	}
	base["mode"] = m
	return base, nil
}

// snellObfsMode reads extra_json["obfs_mode"] for snell v5. Defaults to
// "none"; only "none" and "http" are valid.
func snellObfsMode(extra map[string]any) (string, error) {
	v, ok := extra["obfs_mode"]
	if !ok {
		return "none", nil
	}
	s, _ := v.(string)
	switch s {
	case "":
		return "none", nil
	case "none", "http":
		return s, nil
	}
	return "", fmt.Errorf("obfs_mode %q invalid (want none or http)", s)
}

// snellMode reads extra_json["mode"] for snell v6 traffic shaping.
// Defaults to "default".
func snellMode(extra map[string]any) (string, error) {
	v, ok := extra["mode"]
	if !ok {
		return "default", nil
	}
	s, _ := v.(string)
	switch s {
	case "":
		return "default", nil
	case "default", "unshaped", "unsafe-raw":
		return s, nil
	}
	return "", fmt.Errorf("mode %q invalid (want default, unshaped or unsafe-raw)", s)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test ./internal/plugins/singbox/ -run 'TestRender_Snell' -v && go test -race ./internal/plugins/singbox/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/render.go internal/plugins/singbox/render_test.go
git commit -m "feat(singbox): render snell v5/v6 inbounds with enum-validated obfs_mode/mode"
```

---

### Task 3: 中继代理出站（含 5→4 版本映射）

**Files:**
- Modify: `internal/plugins/singbox/render.go:426-513`（`renderRelayOutbound` switch）
- Test: `internal/plugins/singbox/render_test.go`

**Interfaces:**
- Consumes: Task 2 的枚举 helper `snellObfsMode`。
- Produces: `renderRelayOutbound` 支持 `snell-v5`/`snell-v6` 上游。

- [ ] **Step 1: 写失败测试**

```go
func TestRenderRelayOutbound_SnellV5MapsToVersion4(t *testing.T) {
	in := InboundView{}
	in.Tag = "relay-x"
	in.Role = "relay"
	in.RelayMode = "proxy"
	in.UpstreamTag = sql.NullString{String: "landing-snell", Valid: true}
	in.UpstreamAddress = sql.NullString{String: "1.2.3.4", Valid: true}
	in.UpstreamPort = sql.NullInt64{Int64: 8443, Valid: true}
	in.UpstreamProtocol = sql.NullString{String: "snell-v5", Valid: true}
	in.UpstreamPassword = sql.NullString{String: "psk-abc", Valid: true}

	ob, err := renderRelayOutbound(in)
	if err != nil {
		t.Fatalf("renderRelayOutbound: %v", err)
	}
	if ob["type"] != "snell" {
		t.Errorf("type = %v, want snell", ob["type"])
	}
	// sing-box snell OUTBOUND only accepts version 4 or 6 — passing 5
	// makes the config fail to parse.
	if ob["version"] != 4 {
		t.Errorf("version = %v, want 4 (v5 landing must dial as v4)", ob["version"])
	}
	if ob["psk"] != "psk-abc" {
		t.Errorf("psk = %v, want psk-abc", ob["psk"])
	}
}

func TestRenderRelayOutbound_SnellV6StaysVersion6(t *testing.T) {
	in := InboundView{}
	in.Tag = "relay-x"
	in.Role = "relay"
	in.RelayMode = "proxy"
	in.UpstreamTag = sql.NullString{String: "landing-snell6", Valid: true}
	in.UpstreamAddress = sql.NullString{String: "1.2.3.4", Valid: true}
	in.UpstreamPort = sql.NullInt64{Int64: 8443, Valid: true}
	in.UpstreamProtocol = sql.NullString{String: "snell-v6", Valid: true}
	in.UpstreamPassword = sql.NullString{String: "psk-abc", Valid: true}

	ob, err := renderRelayOutbound(in)
	if err != nil {
		t.Fatalf("renderRelayOutbound: %v", err)
	}
	if ob["version"] != 6 {
		t.Errorf("version = %v, want 6", ob["version"])
	}
	if _, ok := ob["obfs_mode"]; ok {
		t.Error("v6 outbound must not carry obfs_mode")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/plugins/singbox/ -run 'TestRenderRelayOutbound_Snell' -v`
Expected: FAIL，报 `unsupported upstream protocol: snell-v5`。

- [ ] **Step 3: 实现**

在 `renderRelayOutbound` 的 `case "shadowsocks-2022":` 之后插入：

```go
	case "snell-v5", "snell-v6":
		ob["type"] = "snell"
		ob["psk"] = in.UpstreamPassword.String
		// sing-box snell outbound accepts version 4 or 6 only. The v5
		// wire protocol is identical to v4, so a v5 landing is dialed
		// as v4; sending 5 fails config parsing outright.
		if in.UpstreamProtocol.String == "snell-v6" {
			ob["version"] = 6
		} else {
			ob["version"] = 4
			var extra map[string]any
			if in.UpstreamExtraJSON.Valid && in.UpstreamExtraJSON.String != "" {
				if err := json.Unmarshal([]byte(in.UpstreamExtraJSON.String), &extra); err != nil {
					return nil, fmt.Errorf("relay %s: bad upstream extra_json: %w", in.Tag, err)
				}
			}
			m, err := snellObfsMode(extra)
			if err != nil {
				return nil, fmt.Errorf("relay %s: %w", in.Tag, err)
			}
			if m != "none" {
				ob["obfs_mode"] = m
			}
		}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test -race ./internal/plugins/singbox/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/render.go internal/plugins/singbox/render_test.go
git commit -m "feat(singbox): snell relay proxy outbound with v5->v4 version mapping"
```

---

### Task 4: 部署时版本门禁

**Files:**
- Modify: `internal/plugins/singbox/deploy_server.go:37-60`（`AssembleAndDeploy`，在过滤出 `mine` 之后、`mkdir` 之前插入检查）
- Create: `internal/plugins/singbox/version_gate.go`
- Test: `internal/plugins/singbox/version_gate_test.go`

**Interfaces:**
- Produces:
  - `func requiresSingbox114(protocol string) bool`
  - `func singboxMinorAtLeast(version string, wantMajor, wantMinor int) bool` — 解析 `major.minor`（容忍 `v` 前缀与 `-beta.N` 后缀），无法解析返回 false。
  - `func checkSnellVersionGate(ctx context.Context, db *sqlx.DB, serverID int64, views []InboundView) error`

- [ ] **Step 1: 写失败测试** `internal/plugins/singbox/version_gate_test.go`：

```go
package singbox

import "testing"

func TestSingboxMinorAtLeast(t *testing.T) {
	cases := []struct {
		version string
		want    bool
	}{
		{"1.14.0", true},
		{"v1.14.0", true},
		{"1.14.0-beta.2", true},
		{"v1.14.0-beta.2", true},
		{"1.15.3", true},
		{"2.0.0", true},
		{"1.13.14", false},
		{"1.13.12", false},
		{"1.9.0", false},
		{"", false},
		{"garbage", false},
	}
	for _, c := range cases {
		if got := singboxMinorAtLeast(c.version, 1, 14); got != c.want {
			t.Errorf("singboxMinorAtLeast(%q, 1, 14) = %v, want %v", c.version, got, c.want)
		}
	}
}

func TestRequiresSingbox114(t *testing.T) {
	if !requiresSingbox114("snell-v5") || !requiresSingbox114("snell-v6") {
		t.Error("snell protocols must require 1.14")
	}
	if requiresSingbox114("hysteria2") || requiresSingbox114("vless-reality") {
		t.Error("non-snell protocols must not require 1.14")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/plugins/singbox/ -run 'VersionAtLeast|Requires' -v`
Expected: FAIL（未定义）。

- [ ] **Step 3: 实现** `internal/plugins/singbox/version_gate.go`：

```go
package singbox

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// requiresSingbox114 reports whether a protocol needs sing-box 1.14+.
// snell inbounds landed upstream in 1.14.0-alpha.38.
func requiresSingbox114(protocol string) bool {
	return protocol == "snell-v5" || protocol == "snell-v6"
}

// singboxMinorAtLeast compares only major.minor, which is all the 1.14
// boundary needs. It tolerates a leading "v" and any pre-release suffix,
// so "v1.14.0-beta.2" counts as 1.14. Unparseable input returns false —
// deployed_version is free-form and an unknown value must not silently
// pass a gate.
func singboxMinorAtLeast(version string, wantMajor, wantMinor int) bool {
	s := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) < 2 {
		return false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	if major != wantMajor {
		return major > wantMajor
	}
	return minor >= wantMinor
}

// checkSnellVersionGate refuses to deploy a config containing snell
// inbounds to a host running sing-box older than 1.14. Without this the
// binary rejects the config with a FATAL in journalctl that the panel
// never surfaces — plugin_hosts.deployed_version records what we told the
// agent to install, it is never measured.
func checkSnellVersionGate(ctx context.Context, db *sqlx.DB, serverID int64, views []InboundView) error {
	var needs []string
	for _, v := range views {
		if requiresSingbox114(v.Protocol) {
			needs = append(needs, v.Tag)
		}
	}
	if len(needs) == 0 {
		return nil
	}
	store := &plugins.Store{DB: db}
	host, err := store.GetHost(ctx, "singbox", serverID)
	if err != nil {
		return fmt.Errorf("snell inbounds %v require sing-box 1.14+, but the deployed version is unknown: %w", needs, err)
	}
	if !singboxMinorAtLeast(host.DeployedVersion.String, 1, 14) {
		return fmt.Errorf("snell inbounds %v require sing-box 1.14+, server %d has %q — upgrade it on the Deploy tab first",
			needs, serverID, host.DeployedVersion.String)
	}
	return nil
}
```

> `plugins.Store` 的实际构造/包路径以 `internal/plugins/store.go` 为准；若 `Store` 字段名不是 `DB` 或模块路径不同，按仓库现状调整 import 与字面量，函数签名保持不变。

`deploy_server.go` 中，在 `if len(mine) == 0 { ... }` 之后、`mkdir` 之前插入：

```go
	if err := checkSnellVersionGate(ctx, deps.DB, serverID, mine); err != nil {
		return err
	}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test -race ./internal/plugins/singbox/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/singbox/version_gate.go internal/plugins/singbox/version_gate_test.go internal/plugins/singbox/deploy_server.go
git commit -m "feat(singbox): block snell deploys to hosts below sing-box 1.14"
```

---

### Task 5: subgen 节点映射

**Files:**
- Modify: `internal/plugins/subgen/node.go:9-33`（`Node` 注释）、`:55-74`（`baseScheme`）、`:200-228`（`singboxInboundToNode`）
- Test: `internal/plugins/subgen/node_test.go`

**Interfaces:**
- Produces: snell inbound → `Node{Protocol: "snell", Password: <psk>, Extra: {"snell_version": 5|6, ...extra_json}}`。
  - `Extra["snell_version"]` 是 **int**（5 或 6）。
  - v5 的 `obfs_mode`、v6 的 `mode` 由既有的 extra_json 反序列化自动进入 `Extra`。
- `collect.go` 的 SQL 无需改动——它已经 SELECT 了 `i.protocol`、`i.password`、`i.extra_json`。

- [ ] **Step 1: 写失败测试**（追加到 `node_test.go`）：

```go
func TestSingboxInboundToNode_SnellV5(t *testing.T) {
	psk := "psk-abc"
	extra := `{"obfs_mode":"http"}`
	in := singboxLite{
		Tag: "landing-snell", Port: 8443, Protocol: "snell-v5",
		Role: "landing", Password: &psk, ExtraJSON: &extra,
	}
	srv := serverLite{Host: "1.2.3.4", Name: "hk1", Country: "HK"}
	n := singboxInboundToNode(in, srv)

	if n.Protocol != "snell" {
		t.Errorf("Protocol = %q, want snell", n.Protocol)
	}
	if n.Password != psk {
		t.Errorf("Password = %q, want %q", n.Password, psk)
	}
	if n.Extra["snell_version"] != 5 {
		t.Errorf("Extra[snell_version] = %v (%T), want 5 (int)", n.Extra["snell_version"], n.Extra["snell_version"])
	}
	if n.Extra["obfs_mode"] != "http" {
		t.Errorf("Extra[obfs_mode] = %v, want http", n.Extra["obfs_mode"])
	}
}

func TestSingboxInboundToNode_SnellV6NoExtraJSON(t *testing.T) {
	psk := "psk-abc"
	in := singboxLite{
		Tag: "landing-snell6", Port: 8443, Protocol: "snell-v6",
		Role: "landing", Password: &psk,
	}
	srv := serverLite{Host: "1.2.3.4", Name: "hk1", Country: "HK"}
	n := singboxInboundToNode(in, srv)

	if n.Protocol != "snell" {
		t.Errorf("Protocol = %q, want snell", n.Protocol)
	}
	// Extra must exist even with no extra_json — the version lives there.
	if n.Extra == nil {
		t.Fatal("Extra is nil; snell_version must be set even without extra_json")
	}
	if n.Extra["snell_version"] != 6 {
		t.Errorf("Extra[snell_version] = %v, want 6", n.Extra["snell_version"])
	}
}
```

> `singboxLite`/`serverLite` 的字面量字段以 `node.go` / `collect.go` 现状为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/plugins/subgen/ -run 'Snell' -v`
Expected: FAIL（Protocol 是 `snell-v5`，Extra 无 snell_version）。

- [ ] **Step 3: 实现**

`node.go:11` 的 `Protocol` 注释改为：

```go
	Protocol string // vless|vmess|trojan|shadowsocks|hysteria2|tuic|anytls|wireguard|snell
```

`baseScheme` 的 switch 在 `case proto == "anytls":` 之后插入：

```go
	case proto == "snell-v5" || proto == "snell-v6":
		return "snell"
```

`singboxInboundToNode` 中，在 `if e := deref(in.ExtraJSON); e != "" { ... }` 之后、`n.Insecure = ...` 之前插入：

```go
	// snell carries its protocol version in the inbound protocol name;
	// downstream renderers need it to pick the version each client
	// accepts (Surge takes 5/6, mihomo caps at 4 and rejects 6).
	if in.Protocol == "snell-v5" || in.Protocol == "snell-v6" {
		if n.Extra == nil {
			n.Extra = map[string]any{}
		}
		if in.Protocol == "snell-v6" {
			n.Extra["snell_version"] = 6
		} else {
			n.Extra["snell_version"] = 5
		}
	}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `go test -race ./internal/plugins/subgen/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/node.go internal/plugins/subgen/node_test.go
git commit -m "feat(subgen): map snell inbounds to nodes carrying snell_version"
```

---

### Task 6: Surge / Shadowrocket 订阅渲染

**Files:**
- Modify: `internal/plugins/subgen/render_surge.go:14-20`（`Supports`）、`:22-98`（`proxyLine`）、`:108-174`（`render`，只有在需要按 target 区分版本时才改）
- Test: `internal/plugins/subgen/render_surge_test.go`、`internal/plugins/subgen/render_shadowrocket_test.go`

**Interfaces:**
- Consumes: Task 5 的 `Node.Extra["snell_version"]`。
- Produces: `snellVersionFor(n Node, target string) int` — Surge 返回 5/6，其它 target 把 5 映射为 4、6 返回 0（表示"跳过"）。
- `ShadowRocketRenderer` 内嵌 `SurgeRenderer`，自动继承。

- [ ] **Step 1: 写失败测试**（追加到 `render_surge_test.go`）：

```go
func TestSurge_SnellV5(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 5, "obfs_mode": "http"},
	}
	line := (&SurgeRenderer{}).proxyLine(n)
	for _, want := range []string{"= snell,", "1.2.3.4", "8443", "psk=psk-abc", "version=5", "obfs=http"} {
		if !strings.Contains(line, want) {
			t.Errorf("surge line %q missing %q", line, want)
		}
	}
}

func TestSurge_SnellV6HasNoObfs(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 6},
	}
	line := (&SurgeRenderer{}).proxyLine(n)
	if !strings.Contains(line, "version=6") {
		t.Errorf("surge line %q missing version=6", line)
	}
	if strings.Contains(line, "obfs") {
		t.Errorf("surge v6 line must not carry obfs: %q", line)
	}
}

func TestShadowrocket_SnellV5DowngradesToV4(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 5},
	}
	line := (&ShadowRocketRenderer{}).proxyLine(n)
	if !strings.Contains(line, "version=4") {
		t.Errorf("shadowrocket must dial a v5 landing as v4, got %q", line)
	}
}

func TestShadowrocket_SnellV6Skipped(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 6},
	}
	if line := (&ShadowRocketRenderer{}).proxyLine(n); line != "" {
		t.Errorf("shadowrocket must skip snell v6 (client rejects it), got %q", line)
	}
}
```

> `proxyLine` 若当前是非导出方法且签名为 `(r *SurgeRenderer) proxyLine(n Node) string`，测试如上即可；若渲染器需要知道 target，改为在 `SurgeRenderer` 上加一个 `target` 字段并由 `ShadowRocketRenderer` 构造时设置——保持 `proxyLine(n Node) string` 签名不变。

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/plugins/subgen/ -run 'Surge_Snell|Shadowrocket_Snell' -v`
Expected: FAIL（proxyLine 无 snell 分支，返回空串）。

- [ ] **Step 3: 实现**

`Supports` 的 case 列表加 `"snell"`：

```go
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls", "wireguard", "snell":
```

在 `render_surge.go` 末尾新增：

```go
// snellVersionFor picks the snell version to write for a target client.
// Surge speaks 4/5/6 natively. Every other Surge-syntax client caps out
// at v4 — a v5 landing is dialed as v4 (the v5 wire protocol is
// backward-compatible), and v6 has no v4 fallback at all, so it is
// skipped. Returns 0 to mean "skip this node".
func snellVersionFor(n Node, target string) int {
	v, _ := n.Extra["snell_version"].(int)
	if v == 0 {
		// Tolerate float64 from a JSON round-trip.
		if f, ok := n.Extra["snell_version"].(float64); ok {
			v = int(f)
		}
	}
	if target == "surge" {
		return v
	}
	switch v {
	case 5:
		return 4
	case 6:
		return 0
	}
	return v
}
```

`proxyLine` 的 switch 加 snell 分支（放在 `case "anytls":` 之后）：

```go
	case "snell":
		ver := snellVersionFor(n, r.target())
		if ver == 0 {
			return ""
		}
		fmt.Fprintf(&b, "%s = snell, %s, %d, psk=%s, version=%d", n.Name, n.Server, n.Port, n.Password, ver)
		// obfs belongs to the v4/v5 generation; v6 replaces it with
		// server-side traffic shaping and takes no client-side param.
		if ver != 6 {
			if m, _ := n.Extra["obfs_mode"].(string); m == "http" {
				b.WriteString(", obfs=http")
				if h, _ := n.Extra["obfs_host"].(string); h != "" {
					b.WriteString(", obfs-host=" + h)
				}
			}
		}
```

`SurgeRenderer` 增加 target 自述方法（若已有等价机制则复用）：

```go
func (*SurgeRenderer) target() string        { return "surge" }
func (*ShadowRocketRenderer) target() string { return "shadowrocket" }
```

> `proxyLine` 目前挂在 `*SurgeRenderer` 上，`ShadowRocketRenderer` 通过内嵌继承——内嵌不会让 `r.target()` 派发到子类型。因此实现时把 `proxyLine` 改为接受 target 参数（`proxyLine(n Node, target string) string`）并在两个渲染器的 `Render` 里各自传入自己的 target，同步更新既有调用点与测试中的调用方式。**这是本任务唯一需要改动既有签名的地方，务必一次改干净。**

调用方 `render()` 中遇到 `proxyLine` 返回空串的节点必须整节点跳过（不写 `[Proxy]` 行，也不把节点名放进任何 group/policy 列表）——检查 `render_surge.go:108-174` 的现有节点循环，确保空串走 `continue` 而不是写出空行。

- [ ] **Step 4: 跑测试确认通过**

Run: `go test -race ./internal/plugins/subgen/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/render_surge.go internal/plugins/subgen/render_shadowrocket.go internal/plugins/subgen/render_surge_test.go internal/plugins/subgen/render_shadowrocket_test.go
git commit -m "feat(subgen): snell in surge/shadowrocket output with per-client version downgrade"
```

---

### Task 7: clash/mihomo 订阅渲染（v6 过滤）

**Files:**
- Modify: `internal/plugins/subgen/render_clash.go:16-22`（`Supports`）、`:318-421`（`clashProxy`）
- Test: `internal/plugins/subgen/render_clash_test.go`

**Interfaces:**
- Consumes: Task 5 的 `Node.Extra["snell_version"]`、Task 6 的 `snellVersionFor`。
- Produces: `clashProxy` 对 snell v5 返回 `{type: "snell", psk, version: 4, ...}`；对 snell v6 返回 `nil`（`clashProxy` 已有"nil 表示不支持"的约定）。

- [ ] **Step 1: 写失败测试**

```go
func TestClash_SnellV5DowngradesToV4(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 5, "obfs_mode": "http", "obfs_host": "bing.com"},
	}
	p := clashProxy(n)
	if p == nil {
		t.Fatal("clashProxy returned nil for snell v5")
	}
	if p["type"] != "snell" {
		t.Errorf("type = %v, want snell", p["type"])
	}
	if p["psk"] != "psk-abc" {
		t.Errorf("psk = %v, want psk-abc", p["psk"])
	}
	// mihomo silently rewrites 5 to 4; writing 4 ourselves keeps the
	// emitted config honest. Omitting version entirely would default to
	// v1 in mihomo and fail to connect.
	if p["version"] != 4 {
		t.Errorf("version = %v, want 4", p["version"])
	}
	obfs, ok := p["obfs-opts"].(map[string]any)
	if !ok {
		t.Fatalf("obfs-opts missing or wrong type: %#v", p["obfs-opts"])
	}
	if obfs["mode"] != "http" || obfs["host"] != "bing.com" {
		t.Errorf("obfs-opts = %#v, want mode=http host=bing.com", obfs)
	}
}

func TestClash_SnellV6Skipped(t *testing.T) {
	n := Node{
		Name: "hk1", Protocol: "snell", Server: "1.2.3.4", Port: 8443,
		Password: "psk-abc",
		Extra:    map[string]any{"snell_version": 6},
	}
	// mihomo hard-errors on version 6 ("snell version error: 6"), so the
	// node must be omitted rather than downgraded.
	if p := clashProxy(n); p != nil {
		t.Errorf("clashProxy must return nil for snell v6, got %#v", p)
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `go test ./internal/plugins/subgen/ -run 'Clash_Snell' -v`
Expected: FAIL（clashProxy 无 snell 分支）。

- [ ] **Step 3: 实现**

`Supports` 的 case 列表加 `"snell"`：

```go
	case "shadowsocks", "vmess", "trojan", "vless", "hysteria2", "tuic", "anytls", "wireguard", "snell":
```

`clashProxy` 的 switch 加分支（放在 `case "anytls":` 之后）：

```go
	case "snell":
		ver := snellVersionFor(n, "clash")
		if ver == 0 {
			// mihomo rejects snell v6 outright; skip instead of
			// emitting a proxy the client refuses to load.
			return nil
		}
		p["type"] = "snell"
		p["psk"] = n.Password
		p["version"] = ver
		if m, _ := n.Extra["obfs_mode"].(string); m == "http" {
			opts := map[string]any{"mode": "http"}
			if h, _ := n.Extra["obfs_host"].(string); h != "" {
				opts["host"] = h
			}
			p["obfs-opts"] = opts
		}
```

确认 `clashProxy` 返回 nil 的节点在 `Render` 中被完整跳过（不出现在 `proxies` 列表，也不出现在任何 proxy-group 的 `proxies` 名单里）——若现有代码只跳过 proxies 而仍把名字塞进 group，本任务一并修掉并加断言。

- [ ] **Step 4: 跑测试确认通过**

Run: `go test -race ./internal/plugins/subgen/ && golangci-lint run ./internal/...`
Expected: PASS，lint 无输出

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/subgen/render_clash.go internal/plugins/subgen/render_clash_test.go
git commit -m "feat(subgen): snell in clash output, filtering v6 that mihomo rejects"
```

---

### Task 8: sing-box check 配置冒烟测试

**Files:**
- Create: `internal/plugins/singbox/config_check_test.go`

**Interfaces:**
- Consumes: Task 2/3 的渲染结果。
- Produces: 无（纯测试）。

本仓库目前没有任何"渲染产物能否被真实二进制接受"的验证手段，而 snell 要跑在 beta 上。该测试在找不到二进制时 `t.Skip`，因此不阻塞 CI。

- [ ] **Step 1: 写测试** `internal/plugins/singbox/config_check_test.go`：

```go
package singbox

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestRenderedConfigPassesSingboxCheck runs the real sing-box binary
// against a rendered config. Set SINGBOX_BIN to a 1.14+ binary to
// exercise it; the test skips when unset so CI stays green without the
// binary. This is the only check that the config we generate is actually
// accepted — everything else asserts our own map shapes.
func TestRenderedConfigPassesSingboxCheck(t *testing.T) {
	bin := os.Getenv("SINGBOX_BIN")
	if bin == "" {
		t.Skip("SINGBOX_BIN not set; skipping real sing-box config check")
	}
	psk := "psk-abcdefghijklmnop"
	extraV5 := `{"obfs_mode":"http"}`
	extraV6 := `{"mode":"unshaped"}`
	views := []InboundView{
		{Inbound: Inbound{ServerID: 1, Tag: "landing-snell5", Port: 8443, Role: "landing", Protocol: "snell-v5", Password: &psk, ExtraJSON: &extraV5}},
		{Inbound: Inbound{ServerID: 1, Tag: "landing-snell6", Port: 8444, Role: "landing", Protocol: "snell-v6", Password: &psk, ExtraJSON: &extraV6}},
	}
	cfg, err := RenderServerConfig(views, nil)
	if err != nil {
		t.Fatalf("RenderServerConfig: %v", err)
	}
	path := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(path, cfg, 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	out, err := exec.Command(bin, "check", "-c", path).CombinedOutput()
	if err != nil {
		t.Fatalf("sing-box check rejected the rendered config: %v\n%s\nconfig:\n%s", err, out, cfg)
	}
}
```

> `InboundView`/`Inbound` 字面量以 `render_test.go` 现状为准。

- [ ] **Step 2: 跑测试（无二进制时应跳过）**

Run: `go test ./internal/plugins/singbox/ -run 'SingboxCheck' -v`
Expected: `--- SKIP` 且整体 ok

- [ ] **Step 3: 用真实二进制跑一次**

从 GitHub 下载 `v1.14.0-beta.2` 的 linux/darwin 对应包（或本机已有的 1.14 二进制），然后：

Run: `SINGBOX_BIN=/path/to/sing-box go test ./internal/plugins/singbox/ -run 'SingboxCheck' -v`
Expected: PASS。**若 sing-box 报错，说明渲染字段与 1.14 实际 schema 不符——修 Task 2/3 的渲染逻辑，不要改测试。**

- [ ] **Step 4: Commit**

```bash
git add internal/plugins/singbox/config_check_test.go
git commit -m "test(singbox): verify rendered config against a real sing-box binary"
```

---

### Task 9: 前端协议支持

**Files:**
- Modify: `web/src/api/plugins.ts:270-276`（`SingboxProtocol`）
- Modify: `web/src/pages/admin/plugins/singbox/InboundDialog.tsx:19-38`（`PROTOCOLS`）、`:48-78`（字段谓词）、`:150-208`（提交 body 组装）、表单渲染区
- Modify: `web/src/pages/admin/plugins/singbox/InboundsTab.tsx:20-39`（`SINGBOX_URL_PROTOCOLS`）
- Modify: `web/src/locales/en.json`、`web/src/locales/zh-CN.json`（`singbox` 命名空间）
- Test: `web/src/pages/admin/plugins/singbox/InboundDialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 的协议值、Task 2 的 extra_json 字段名（`obfs_mode`、`mode`）。
- Produces: 表单为 snell 提交 `{protocol, password, extra: JSON.stringify({obfs_mode})}`（v5）或 `{..., extra: JSON.stringify({mode})}`（v6）。

- [ ] **Step 1: 写失败测试**（追加到 `InboundDialog.test.tsx`，沿用文件现有的 render/provider 方式）：

```tsx
test('snell-v5 shows PSK and obfs but hides cert/SNI/transport', async () => {
  render(<InboundDialog open onOpenChange={() => {}} servers={[{ id: 1, name: 'hk1' }]} />)
  await userEvent.selectOptions(screen.getByLabelText(/protocol/i), 'snell-v5')
  expect(screen.getByLabelText(/psk/i)).toBeInTheDocument()
  expect(screen.getByLabelText(/obfs/i)).toBeInTheDocument()
  expect(screen.queryByLabelText(/sni/i)).not.toBeInTheDocument()
  expect(screen.queryByLabelText(/uuid/i)).not.toBeInTheDocument()
})

test('snell-v6 shows mode instead of obfs', async () => {
  render(<InboundDialog open onOpenChange={() => {}} servers={[{ id: 1, name: 'hk1' }]} />)
  await userEvent.selectOptions(screen.getByLabelText(/protocol/i), 'snell-v6')
  expect(screen.getByLabelText(/mode/i)).toBeInTheDocument()
  expect(screen.queryByLabelText(/obfs/i)).not.toBeInTheDocument()
})
```

> props 与查询方式以 `InboundDialog.test.tsx` 现有测试为准（该组件的实际 props、是否需要 QueryClient wrapper 等）。若组件用 shadcn `Select` 而非原生 `<select>`，改用现有测试里对 Select 的既定交互方式。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/InboundDialog.test.tsx`
Expected: FAIL（下拉里没有 snell-v5）。

- [ ] **Step 3: 实现**

`web/src/api/plugins.ts` 的 `SingboxProtocol` 联合类型追加：

```ts
  | 'snell-v5'
  | 'snell-v6'
```

`InboundDialog.tsx` 的 `PROTOCOLS` 数组追加两项（沿用数组中现有的元素形状，label 走 i18n key）：

```ts
  { value: 'snell-v5', label: 'Snell v5' },
  { value: 'snell-v6', label: 'Snell v6' },
```

字段谓词：

```ts
const isSnell = (p: string) => p === 'snell-v5' || p === 'snell-v6'
```

- `needsPassword`：加 `|| isSnell(p)`
- `needsUUID` / `needsReality` / `needsCertAndSNI` / `needsTransport` / `needsSS`：确保对 snell 返回 false（若这些谓词是白名单式的 `p === 'x' || p === 'y'`，则天然为 false，无需改动；若是黑名单式的 `!...`，必须显式排除 snell）

表单新增（放在 password 字段之后）：

```tsx
{protocol === 'snell-v5' && (
  <div className="grid gap-1.5">
    <Label htmlFor="snell-obfs">{t('singbox.snell.obfs_mode')}</Label>
    <select id="snell-obfs" value={snellObfs} onChange={(e) => setSnellObfs(e.target.value)} ...>
      <option value="none">none</option>
      <option value="http">http</option>
    </select>
  </div>
)}
{protocol === 'snell-v6' && (
  <div className="grid gap-1.5">
    <Label htmlFor="snell-mode">{t('singbox.snell.mode')}</Label>
    <select id="snell-mode" value={snellMode} onChange={(e) => setSnellMode(e.target.value)} ...>
      <option value="default">default</option>
      <option value="unshaped">unshaped</option>
      <option value="unsafe-raw">unsafe-raw</option>
    </select>
  </div>
)}
```

> 表单控件的具体写法（原生 select 还是 shadcn `Select`、className）以该文件现有字段为准，保持一致。密码字段在 snell 下的 label 改为 PSK（i18n key `singbox.snell.psk`）。

提交 body 组装处，snell 时写 `extra`：

```ts
if (protocol === 'snell-v5') body.extra = JSON.stringify({ obfs_mode: snellObfs })
if (protocol === 'snell-v6') body.extra = JSON.stringify({ mode: snellMode })
```

`InboundsTab.tsx` 的 `SINGBOX_URL_PROTOCOLS`：**不要加 snell**。snell 没有事实标准的分享链接格式，`buildSingboxShareURL` 对它返回 null 即可（该函数默认分支已 `return null`）。在该 Set 上方的注释里补一句说明。

i18n（en / zh-CN 的 `singbox` 命名空间同步添加）：

```json
"snell": { "psk": "PSK", "obfs_mode": "Obfuscation", "mode": "Traffic mode" }
```
```json
"snell": { "psk": "PSK", "obfs_mode": "混淆", "mode": "流量模式" }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd web && npx vitest run src/pages/admin/plugins/singbox/ && npm run build && npm test && bash ../scripts/check-ui-tokens.sh`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add web/src
git commit -m "feat(web): snell v5/v6 in the singbox inbound form"
```

---

### Task 10: mobile 同步

**Files:**
- Modify: `mobile/src/api/inbounds.ts:293-312`（`SINGBOX_PROTOCOLS`）、`:276-282`（`SINGBOX_URL_PROTOCOLS`）、`:331-350`（字段谓词）
- Modify: `mobile/src/app/(app)/plugin/[id]/inbound-form.tsx:140-380`（`SingboxForm`）
- Test: `mobile/src/app/(app)/plugin/[id]/__tests__/inbound-form.test.tsx`

**Interfaces:**
- Consumes: Task 9 的字段语义（`extra` 里 `obfs_mode` / `mode`）。mobile 与 web 是 1:1 移植关系，行为必须一致。

⚠️ `mobile/AGENTS.md` 要求：动手前先读 https://docs.expo.dev/versions/v56.0.0/ 的对应文档。

- [ ] **Step 1: 写失败测试**（追加到 `inbound-form.test.tsx`，沿用现有渲染方式）：

```tsx
it('shows PSK and obfs for snell-v5, mode for snell-v6', async () => {
  const { getByText, queryByText } = renderForm({ protocol: 'snell-v5' })
  expect(getByText(/PSK/i)).toBeTruthy()
  expect(queryByText(/SNI/i)).toBeNull()
})
```

> `renderForm` helper 与查询方式以现有测试为准。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd mobile && npx jest src/app/\(app\)/plugin/\[id\]/__tests__/inbound-form.test.tsx`
Expected: FAIL

（若 mobile 用的是 vitest 而非 jest，改用 `npm test -- <path>`；以 `mobile/package.json` 的 `scripts.test` 为准。）

- [ ] **Step 3: 实现**

`SINGBOX_PROTOCOLS` 追加 `'snell-v5'`、`'snell-v6'`（与 web 的 `PROTOCOLS` 逐项对齐）。
`SINGBOX_URL_PROTOCOLS`：**不加** snell（与 web 一致，无分享链接标准）。
字段谓词：新增 `isSnell`，`needsPassword` 加 `|| isSnell(p)`，其余谓词确保 snell 为 false。
`SingboxForm` 加两个选择控件（v5 的 obfs_mode、v6 的 mode），提交时写入 `extra`，与 web 的 JSON 形状完全一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd mobile && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add mobile/src
git commit -m "feat(mobile): snell v5/v6 in the singbox inbound form"
```

---

### Task 11: CI 构建 1.14 beta

**Files:**
- Modify: `.github/workflows/sing-box-build.yml:98-109`（build tag 过滤）、`:21`（input 描述文案）

**Interfaces:** 无代码接口，产出是 GitHub release 资产 `singbox-v1.14.0-beta.2-v2rayapi`。

- [ ] **Step 1: 排除 1.14 新增的 build tag**

现有逻辑只剔除 `with_naive_outbound`。1.14 的 `DEFAULT_BUILD_TAGS` 新增了 `with_cloudflared`、`with_usbip`、`with_openvpn`、`with_openconnect` —— 代理服务端用不到，徒增体积且有 `CGO_ENABLED=0` 编译风险。把单模式 grep 改为多模式：

```bash
tags=$(tr ',' '\n' < release/DEFAULT_BUILD_TAGS \
  | grep -v -E '^(with_naive_outbound|with_cloudflared|with_usbip|with_openvpn|with_openconnect)$' \
  | paste -sd, -)
tags="${tags},with_v2ray_api,with_grpc"
```

> 以该文件第 98–109 行的实际写法为准做等价替换，保持变量名与后续引用不变。

- [ ] **Step 2: 更新 input 描述文案**

`:21` 的 `(e.g. v1.13.10)` 改为 `(e.g. v1.14.0-beta.2)`。

- [ ] **Step 3: Commit + 手动触发构建**

```bash
git add .github/workflows/sing-box-build.yml
git commit -m "chore(ci): exclude 1.14's new build tags, document beta version input"
git push -u origin snell-support
gh workflow run sing-box-build.yml -f version=v1.14.0-beta.2
```

- [ ] **Step 4: 验证构建产物**

```bash
gh run watch
gh release view singbox-v1.14.0-beta.2-v2rayapi
```
Expected: amd64 与 arm64 两个 tar.gz + 两个 .sha256；workflow 内的 `strings | grep v2ray.core.app.stats.command.StatsService` 校验通过。

**若构建失败**：多半是新 build tag 或依赖在 `CGO_ENABLED=0` 下的问题——先看是哪个 tag，必要时扩充 Step 1 的排除列表；不要关闭 `CGO_ENABLED=0`。

- [ ] **Step 5: 用产物跑 Task 8 的冒烟**

下载 amd64 产物解包后：

Run: `SINGBOX_BIN=/path/to/sing-box go test ./internal/plugins/singbox/ -run 'SingboxCheck' -v`
Expected: PASS

---

### Task 12: 文档 + 端到端验证

**Files:**
- Modify: `docs/singbox.md`（若存在；否则找 singbox 插件对应的文档文件）
- Modify: `docs/subgen.md:16-24`（target 表格）、`:43` 附近（协议支持说明）

- [ ] **Step 1: 更新文档**

singbox 文档的协议清单加入 snell-v5 / snell-v6，写明：需要主机 sing-box ≥ 1.14（当前只有 beta）；psk 存在 password 字段；obfs_mode / mode 走 extra_json；不支持多用户。

subgen 文档的协议支持说明补充 snell 与降级矩阵：

| 节点 | surge | shadowrocket | clash |
|---|---|---|---|
| snell-v5 | version=5 | version=4 | version: 4 |
| snell-v6 | version=6 | 跳过 | 跳过 |

并注明不提供 `snell://` 分享链接及原因（无事实标准）。

- [ ] **Step 2: 全量门禁**

```bash
go build ./... && go test -race ./... && golangci-lint run
cd web && npm run build && npm test && cd ..
bash scripts/check-ui-tokens.sh
cd mobile && npm test && cd ..
```
Expected: 全绿

- [ ] **Step 3: 端到端冒烟（需要一台真实主机）**

1. 在 Deploy tab 把一台测试主机的 sing-box 升到 `1.14.0-beta.2`。
2. 建一个 `snell-v5` inbound（psk 用 32 位随机串，obfs 选 none），确认部署成功、主机上 `systemctl status shepherd-singbox` 正常。
3. 在**未升级**的另一台主机上建 snell inbound，确认部署被明确拒绝并显示 1.14 要求（Task 4 的门禁）。
4. 把 snell 节点加进一个订阅，分别取 surge / shadowrocket / clash 三种输出，确认：v5 节点在三者中分别是 version=5 / version=4 / version: 4；再建一个 v6 节点，确认它只出现在 surge 输出里。
5. 用 Surge 或 mihomo 实连一次 v5 节点，确认能过流量、面板上流量统计有增长（snell 是常规 inbound，走既有 v2ray-api 计费链路）。

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: snell inbound support and subscription downgrade matrix"
```

---

## Self-Review 记录

- **Spec 覆盖**：协议命名→T1/T2；零迁移数据模型→T2（extra_json）；渲染→T2；流量统计（无需改动，随既有白名单逻辑自动生效）→T12 Step 3.5 验证；中继+版本映射→T3；版本门禁→T4；订阅三格式与降级矩阵→T5/T6/T7；前端→T9；mobile→T10；CI+build tag 排除→T11；测试（render/校验/subgen/配置冒烟）→T2/T3/T5/T6/T7/T8；文档→T12。无缺口。
- **类型一致性**：`snell_version` 全程为 int（T5 写入、T6/T7 读取，T6 的 `snellVersionFor` 额外容忍 float64 以防 JSON round-trip）；`snellVersionFor(n Node, target string) int`，返回 0 表示跳过，T6 与 T7 用法一致；`snellObfsMode`/`snellMode` 在 T2 定义、T3 复用；协议值 `snell-v5`/`snell-v6` 全程一致。
- **已知的签名改动**：T6 需要把 `proxyLine(n Node)` 改为 `proxyLine(n Node, target string)` 并同步既有调用点——已在该任务中明示。
- **无占位符**：所有代码步骤都给了可直接使用的代码；少数以"以文件现状为准"标注的地方，是结构体字面量与测试 helper 的写法差异，不影响逻辑。
