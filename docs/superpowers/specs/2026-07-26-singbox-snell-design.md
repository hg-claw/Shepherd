# sing-box snell inbound 支持设计

日期：2026-07-26
状态：已确认

## 背景与约束

sing-box 自 1.14.0-alpha.38 起原生支持 snell inbound（无需额外 build tag），底层是新的 Go 库 SagerNet/sing-snell。本项目当前锁在 v1.13.12，该版本无 snell。

**上游 1.14 尚无稳定版**：最新 stable 是 v1.13.14（2026-06-25），snell 需要 v1.14.0-beta.2（2026-07-25 发布）。

**客户端生态天花板在 v4**，而 sing-box inbound 只支持 v5/v6：

| 客户端 | snell 支持上限 | 依据 |
|---|---|---|
| Surge | v6（iOS 5.20+/Mac 6.7+） | 官方手册 |
| sing-box | outbound 收 `4\|6` | 官方文档 |
| mihomo/Clash.Meta | v4（源码把 v5 静默降为 v4，v6 直接报错 `snell version error: 6`） | adapter/outbound/snell.go |
| Shadowrocket | Surge 风格语法，版本上限无官方依据 | 第三方手册 + Sub-Store 实现 |
| Surfboard | v4（官方："Version 5 will be treated as version 4."） | 官方文档 |
| Loon / Quantumult X | **不支持 snell** | 官方协议列表 |

关键事实：**v5 服务端向后兼容 v4 客户端**。因此部署 v5 inbound、订阅按客户端能力写不同 version，即可覆盖 Surge / Shadowrocket / mihomo 三类目标客户端。

**`snell://` 无事实标准**：Sub-Store 全仓库零命中，snell-panel 与 sublinkPro 各有互不兼容的私有格式。订阅只走平台专用格式。

**PSK 长度**：sing-box 文档称 v6 要求 12–255 字节，但参考实现 sing-snell 源码对 PSK 长度无任何校验，官方 KB 只有"推荐 32 位随机串"的表述。不将其作为硬约束写入校验逻辑。

## 决策

1. **beta 策略**：代码落地，按主机自选版本。CI 手动构建 1.14 beta 作为可选版本，默认版本保持 1.13.x stable。只有已升级到 1.14+ 的主机能创建 snell inbound。
2. **协议版本**：v5 与 v6 都支持。

## 架构

### 协议命名：两个协议值

新增 `snell-v5` 与 `snell-v6`，而非单个 `snell` + 版本字段。理由：

- 与现有命名一致（`tuic-v5`、`shadowsocks-2022`、`vless-reality` 均把变体写进协议名）。
- 下游每个分发点（渲染 switch、中继出站 switch、subgen 收集、客户端过滤、前端谓词）都能用一次字符串匹配决策。
- "clash 订阅跳过 v6" 这条规则用协议名判断，无需解析 extra_json。

### 数据模型：零迁移

| snell 字段 | 落点 |
|---|---|
| `psk` | 复用现有 `password` 列 |
| `version` | 由协议名承载 |
| `obfs_mode`（v5，`none`/`http`） | `extra_json` |
| `mode`（v6，`default`/`unshaped`/`unsafe-raw`） | `extra_json` |
| `users[]` 多用户 | **不支持**——与现有"一个 inbound 一组凭据"模型一致 |

不新增列、不写 migration。`extra_json` 已被 hysteria2（up_mbps/down_mbps/obfs）与 tuic（congestion_control）用作协议扩展，中继侧的 `upstream_extra_json` 也已存在。

snell 无 TLS 层与 transport 层，`sni`/`cert_id`/`transport_*`/`uuid`/`flow`/`alter_id`/`ss_method` 一律不用。

### 配置渲染

v5：
```json
{"type":"snell","tag":"...","listen":"::","listen_port":N,"version":5,"psk":"...","obfs_mode":"none"}
```
v6：
```json
{"type":"snell","tag":"...","listen":"::","listen_port":N,"version":6,"psk":"...","mode":"default"}
```

`obfs_mode` 缺省 `none`，`mode` 缺省 `default`；两者均从 `extra_json` 读取并做枚举白名单校验，非法值渲染时报错而非透传（1.14 对未知枚举在配置解析阶段即 FATAL）。

### 流量统计

snell 是常规 inbound，其 tag 会随现有逻辑无条件进入 `experimental.v2ray_api.stats.inbounds` 白名单，**计费开箱即用**。不存在此前 WireGuard 方案中 endpoint 不被统计的盲区。

### 中继

- **forward 模式**：走 direct inbound，无需改动。
- **proxy 模式**：`renderRelayOutbound` 新增分支。**必须处理版本映射**——sing-box snell outbound 的版本枚举是 `4|6`（无 5），landing 为 v5 时出站写 `4`，landing 为 v6 时写 `6`。直接透传 5 会导致 `snell: unsupported version: 5` 配置解析失败。

### 版本门禁（两层）

**主校验——部署时**：`AssembleAndDeploy` 在渲染前检查，若目标服务器存在 snell inbound 而 `plugin_hosts.deployed_version` 低于 1.14，以明确错误信息中止部署。

这同时补上一个既有盲点：目前版本不匹配的配置被推下去只会在主机 journalctl 里 FATAL，面板上完全无感（`deployed_version` 是"我告诉 agent 装了什么"的记录，从不实测）。

版本比较只需判断 1.14 分界：解析 `major.minor` 数值比较即可，不做完整 semver（`1.14.0-beta.2` 的 minor 为 14，满足条件）。

**次层——前端**：协议下拉中 snell 选项在所选服务器版本低于 1.14 时置灰并给出提示。若 inbound 视图拿不到该主机的版本，退化为静态说明文案。

> 注：`validatePostInbound` 只持有 `InboundStore`，看不到 `plugin_hosts`，因此不在该处做版本校验。

### 订阅输出

三种格式，按客户端能力分别降级：

| 节点 | Surge | Shadowrocket | mihomo/clash |
|---|---|---|---|
| snell-v5 | `version=5` | `version=4` | `version: 4` |
| snell-v6 | `version=6` | 跳过 | 跳过 |

- v5 向下写 4 是安全的（v5 服务端向后兼容 v4 客户端）。
- v6 在 mihomo 会硬报错，必须**过滤**而非降级。
- obfs 属于 v4/v5 一代的特性：v5 节点带 `obfs=http` 时，Surge/Shadowrocket 写 `obfs=http` + `obfs-host`，mihomo 写 `obfs-opts: {mode: http, host: ...}`。v6 节点无 obfs 参数。
- 不生成 `snell://` 分享链接；前端 share URL 构建器对 snell 返回 null。

### 前端

- 协议列表与 `SingboxProtocol` 类型新增两项。
- 字段谓词：snell 只显示 PSK（`needsPassword`），不显示 UUID/REALITY/证书与 SNI/传输。
- 新增两个下拉写入 `extra_json`：v5 的 `obfs_mode`、v6 的 `mode`。这是 UI 首次暴露 `extra_json`（hysteria2 的同类字段至今仅 API 可设），但枚举各只有 2–3 个值，代价小且让 snell 从界面完整可用。
- mobile 按现有 1:1 移植关系同步 `inbounds.ts` 的协议常量、URL 白名单、字段谓词与表单。

### CI

- `workflow_dispatch` 手动构建 `v1.14.0-beta.2`。cron 用的 `releases/latest` 端点会过滤预发布，因此默认版本自动保持 stable——正是所需行为，不改。
- **排除 1.14 新增的 4 个 build tag**（`with_cloudflared`、`with_usbip`、`with_openvpn`、`with_openconnect`）：代理服务端用不到，徒增体积且有 `CGO_ENABLED=0` 编译风险。现有过滤逻辑只剔除 `with_naive_outbound`，需改为多模式过滤。

## 测试

- **render**：v5/v6 各含默认与 obfs/mode 变体；非法枚举值报错；relay proxy 出站的 5→4 版本映射。
- **路由校验**：协议名合法性；部署时版本门禁拒绝低版本主机。
- **subgen**：inbound → node 映射；三个渲染器的 snell 分支；**"v6 节点不出现在 clash 输出中"** 的显式断言。
- **配置冒烟**：新增一个调用真实 `sing-box check` 校验渲染产物的测试，二进制缺失时 `t.Skip`。本仓库目前完全没有此类验证，而 snell 要跑在 beta 上，这个缺口值得补。

## 不做

多用户 `users[]`；`snell://` 分享链接；Stash/Loon/Quantumult X 输出（后两者不支持 snell）；snell 作为通用出站；升级默认 sing-box 版本。
