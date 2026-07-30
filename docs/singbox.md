# sing-box 插件

**sing-box** 插件在受管主机上运行 `shepherd-singbox`（[SagerNet/sing-box](https://github.com/SagerNet/sing-box) 的分发别名），管理其入站（inbound）配置、TLS 证书（ACME）与流量统计。每个入站有 **landing**（直接落地）或 **relay**（中转，流量再转发到另一台主机上的 landing 入站）两种角色。

## 中继（Relay）

中继有两种模式：

- **转发（forward）**：透明转发原始字节到落地，客户端直接说落地的协议；这种中继不需要凭据，协议字段也随落地自动继承，无需（也无法）单独选择。
- **代理（proxy）**：中继自己终结协议、持有自己的一套凭据，再转发到落地。**代理模式中继的协议可以与落地不同**——例如入口用 `snell-v5`、落地用 `vless-reality`。

创建入口不同，能力也不同：

- **Inbounds → 新建（角色=中继）**：支持转发/代理两种模式；代理模式下协议自由选择，可与落地不同。
- **批量创建中继（Bulk relay）**：只按落地的协议批量铺量，转发和代理模式下新建的中继协议都固定等于落地协议，不支持跨协议。

## 协议支持

在 **插件 → sing-box → Inbounds → 新建** 里可选的协议：

| 协议值 | 说明 |
|---|---|
| `vless-reality` | VLESS + REALITY |
| `vless-ws-tls` / `vless-h2-tls` / `vless-httpupgrade-tls` | VLESS + TLS，三种 transport |
| `vmess-tcp` / `vmess-http` / `vmess-quic` / `vmess-ws-tls` / `vmess-h2-tls` / `vmess-httpupgrade-tls` | VMess，六种 transport |
| `trojan-tls` / `trojan-ws-tls` / `trojan-h2-tls` / `trojan-httpupgrade-tls` | Trojan + TLS，四种 transport |
| `hysteria2` | Hysteria2 |
| `tuic-v5` | TUIC v5 |
| `anytls` | AnyTLS |
| `shadowsocks-2022` | Shadowsocks 2022 |
| `snell-v5` / `snell-v6` | Snell v5 / v6（见下） |

### Snell（`snell-v5` / `snell-v6`）

- **需要主机 sing-box ≥ 1.14**：snell inbound 是 sing-box 1.14 才原生支持的协议（底层库 `SagerNet/sing-snell`）。上游目前还没有 1.14 稳定版，只有 `v1.14.0-beta.2` 可用（截至 2026-07；在 **Deploy** tab 里手动选择该版本）。仍在 1.13.x 的主机上创建 snell 入站会直接返回 409（创建时预检），部署时也会再拒一次，报错提示需要先升级 sing-box。**例外**：forward 模式的 relay 渲染成 `direct` 入站，主机上并不跑 snell，因此不受 1.14 限制、也不需要 PSK。
- **不支持多用户**：与本插件其它协议一致，一个入站只对应一组凭据，不支持 sing-box snell 的 `users[]` 多用户列表。
- **字段落点**（零迁移，不新增数据库列）：
  - PSK 复用现有的 `password` 字段（不是独立的 psk 列）。
  - `obfs_mode`（仅 v5，`none` / `http`，默认 `none`）与 `mode`（仅 v6，`default` / `unshaped` / `unsafe-raw`，默认 `default`）都写在 `extra_json` 里。非法枚举值会在渲染时报错，不会透传给 sing-box（sing-box 1.14 对未知枚举值在配置解析阶段就是 FATAL）。
- snell 没有 TLS 层也没有 transport 层，因此不使用 `sni` / 证书 / transport 相关字段。
- snell 是普通入站，其 tag 会照既有逻辑自动进入 `experimental.v2ray_api.stats.inbounds` 白名单，流量统计开箱即用，不需要额外配置。
- Relay（中转）模式下，出站 snell 的版本枚举只有 `4`/`6`（没有 5）：landing 为 `snell-v5` 时，relay 出站按 `4` 渲染；landing 为 `snell-v6` 时按 `6` 渲染。

订阅（Subscriptions 插件）里 snell 节点在不同客户端格式下的降级/跳过规则，见 [`docs/subgen.md`](./subgen.md#协议支持与降级)。
