# 中继协议解耦：InboundDialog 支持创建中继

日期：2026-07-29
状态：已确认

## 动机

目标拓扑：客户端 → snell → A 机器 → 其它协议（如 vless-reality）→ B 机器。入口用 snell 抗封锁，出口用别的协议落地。

这个拓扑在**后端已经完全可用**，但**没有任何界面能表达它**：

- `web/src/pages/admin/plugins/singbox/InboundDialog.tsx:231` 创建时无条件 `body.role = 'landing'`，不能建中继。
- `web/src/pages/admin/plugins/singbox/BulkRelayDialog.tsx:97,102` 把落地的协议直接抄给中继（`const proto = landing.protocol` → `protocol: proto`），只能做同协议中继。
- mobile 没有任何中继创建入口。

后端侧的现状（无需改动）：

- `internal/plugins/singbox/inbounds_routes.go:110-121` 对 `role=relay` 只要求 `upstream_inbound_id` 存在且指向 landing，**不限制中继协议与落地协议的组合**。
- `internal/plugins/singbox/render.go` 中 `renderInbound` 按**中继自己的**协议渲染入站，`renderRelayOutbound` 按**上游的**协议渲染出站，两者互不干涉；路由规则把两者绑定。
- `internal/plugins/subgen/collect.go:157-172` 只对 **forward** 中继做特判（用落地的协议与凭据 + 中继的 server:port）；**proxy** 中继走通用路径（`:174-182`），用中继自己的协议与凭据。因此协议解耦后订阅自动正确，subgen 一行不改。

## 为什么不扩展 BulkRelayDialog

`buildRelayBody` 在代理模式下依赖**继承落地的 TLS 材料**：`sni: landing.sni`、`cert_id: landing.cert_id`、`transport_path/host: landing.transport_*`。协议一解耦这套继承就失效——落地是 snell 时没有 sni 和证书，而中继若要用 trojan-ws-tls 就需要 A 机器上自己的证书与 SNI，该对话框没有证书选择 UI。

而 BulkRelayDialog 是「每目标服务器一份 draft」的批量结构，再叠加「每协议一套字段（含证书选择）」会变成组合爆炸。InboundDialog 里那套按协议显隐的字段 UI 已经齐全，只差三个控件。

## 设计

### 后端

零改动。

### InboundDialog 创建路径新增三个控件

编辑路径（`isRelayEdit`）行为不变。

1. **角色选择**：落地（默认）/ 中继。
2. **上游落地选择器**（仅角色=中继时显示）：从现有 landing inbound 中选择，每项显示「服务器名 / tag / 协议」，让操作者看清 B 说什么协议。必填；提交时作为 `upstream_inbound_id`。
3. **模式切换**：转发（默认，与 BulkRelayDialog 的默认一致）/ 代理。

### 转发模式

隐藏协议选择器与所有凭据、TLS、transport 字段——后端渲染成 `direct` 入站，这些字段一概不读。

提交时 `protocol` 自动取所选落地的协议。这与 BulkRelayDialog 现有行为一致，并且让两件事继续成立：subgen 的 forward 特判读 `UpProtocol`，列表里的协议标签仍然有意义。

可见字段：服务器、端口、上游落地、别名。

### 代理模式

协议选择器完全自由（全部 20 个协议，含 snell-v5/v6）。现有字段谓词照常驱动显隐：

| 谓词 | 效果 |
|---|---|
| `needsPassword` | trojan / hysteria2 / anytls / ss2022 / snell（标签为 PSK） |
| `needsUUID` | vless / vmess 系 |
| `needsReality` | vless-reality：公私钥、short id、**handshake server/port** |
| `needsCertAndSNI` | TLS 系：证书选择 + SNI（证书来自 A 机器可用的证书列表） |
| `needsTransport` | ws / h2 / httpupgrade |
| `needsSS` | shadowsocks-2022 的加密方式 |
| snell 专属 | v5 的 `obfs_mode`、v6 的 `mode`，写入 `extra` |

凭据沿用现有生成按钮（UUID / 密码 / SS key / x25519 / short id）。

这条路径天然绕开了一个既有 bug（该 bug 本身在下一节单独修）：`validatePostInbound`（`inbounds_routes.go:127-136`）对 `vless-reality` 无条件要求 `reality_handshake_server` 与 `reality_handshake_port`，而 `BulkRelayDialog` 的 proxy+reality 分支不发这两个字段。InboundDialog 本来就有 handshake 字段，走这条路即可正确创建。

### 版本提示

代理模式下选中 snell-v5/v6 且目标服务器的 sing-box 低于 1.14 时，就地显示警告。

数据已经可得：`web/src/api/plugins.ts:24` 的 `deployed_version`，`InboundsTab.tsx:320` 已在按主机渲染它。版本比较只需判断 1.14 分界（容忍前导 `v` 与预发布后缀，`v1.14.0-beta.2` 算 1.14），与后端 `singboxMinorAtLeast` 的口径一致。

这只是提前提示：创建仍会被后端 409 拦下（`inboundNeeds114` 前置校验），警告的作用是让它不成为意外。

### 修复 BulkRelayDialog 的 proxy+reality 创建失败

`buildRelayBody`（`BulkRelayDialog.tsx:113-121`）的 `vless-reality` 分支只发 uuid、sni 与三把 reality 密钥，**不发 handshake**，而后端无条件要求它。结果：批量对话框在代理模式下建 reality 中继一定失败，报 `reality_handshake_server required for vless-reality`。该分支还特意做了 x25519 密钥生成与竞态保护，却在最后一步过不去。

修法是从落地继承 handshake 目标（两个字段已在 GET 响应中暴露，只有私钥被脱敏）：

```ts
reality_handshake_server: landing.reality_handshake_server,
reality_handshake_port: landing.reality_handshake_port,
```

中继仍使用自己新生成的密钥对（`d.privateKey` / `d.publicKey` / `d.shortID`），只是复用同一个伪装目标——这既是合理默认值，也无需新增 UI。

### 顺带修正

`InboundDialog.tsx:289` 编辑中继时的说明文字称「handshake server / port 从上游落地继承，此处不可编辑」。`renderVlessReality`（`render.go:248-281`）读的是**中继行自己的** `RealityHandshakeServer` / `RealityHandshakePort`——上面的修复让批量创建的中继确实是从落地复制来的，但值存在中继行上，不存在运行期继承。修正措辞，避免读者以为改落地就能传播到中继。

## 测试

- 角色切换：选中继后出现上游选择器与模式切换；选落地时三者都不出现。
- 上游选择器只列 landing，不列 relay。
- 转发模式：提交体的 `protocol` 等于所选落地的协议，且不含任何凭据 / TLS / transport 字段。
- 代理模式 + snell-v5：提交 `password`（psk）与 `extra` 的 `obfs_mode`，不含 sni / cert_id / transport。
- 代理模式 + vless-reality：提交包含 `reality_handshake_server` 与 `reality_handshake_port`（这是 BulkRelayDialog 缺失、导致创建失败的字段）。
- 代理模式 + trojan-ws-tls：提交包含 `cert_id`、`sni`、`transport_path`。
- BulkRelayDialog 代理模式 + reality 落地：提交体包含从落地复制来的 `reality_handshake_server` 与 `reality_handshake_port`，且 reality 密钥仍是新生成的（不等于落地的公钥）。该测试在修复前必须失败。
- 版本警告：目标服务器 1.13.x + snell 时出现；1.14.0-beta.2 + snell 时不出现；1.13.x + 非 snell 时不出现。
- 既有落地创建流程与中继编辑流程无回归。

## 不做

- mobile 的中继创建（既有缺口，另开一轮评估）。
- 给 BulkRelayDialog 加协议选择器 / 批量创建混合协议中继——批量场景按用户判断优先级不高，混合协议走 InboundDialog。BulkRelayDialog 本次只修 reality handshake 缺失。
