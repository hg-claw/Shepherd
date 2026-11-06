# 订阅 (subgen)

**订阅(Subscriptions)** 插件根据你已有的 xray 和 sing-box 入站，生成带分类分流的客户端订阅配置。客户端轮询每个订阅的 URL；你通过模板控制分流与输出格式。

## 订阅

一个订阅 = 一组入站节点 + 一个模板 + 一个 token。在 **插件 → Subscriptions** 下创建后：

- **选择节点（Edit nodes）** —— 选择它暴露哪些 xray/sing-box 入站。
- **订阅 URL** —— `/sub/<token>?target=<format>`，复制到客户端导入。
- **轮换 token（Rotate token）** —— 使旧 URL 失效并生成新的。
- **启用（Enabled）** —— 已禁用的订阅返回 404。

## 输出格式

设置 `target` 查询参数：

| `target` | 客户端 | 格式 |
|----------|--------|------|
| `surge` | Surge | Surge `.conf` |
| `shadowrocket` | ShadowRocket | Surge `.conf`（ShadowRocket 兼容读取） |
| `clash` | Clash.Meta / mihomo | YAML |

示例：`https://your-host/sub/abcdef…?target=clash`

## 协议支持与降级

绝大多数协议（vless、vmess、trojan、hysteria2、tuic、anytls、shadowsocks-2022、wireguard）在 surge、shadowrocket、clash 三个 `target` 下渲染方式一致，不做版本区分。**mieru** 在 clash 与 shadowrocket 下渲染，Surge 跳过（无原生支持）。目前只有 **snell**（来自 sing-box 插件的 `snell-v5` / `snell-v6` 入站）按目标客户端能力做版本降级或整节点跳过：

| 节点 | surge | shadowrocket | clash |
|---|---|---|---|
| snell-v5 | `version=5` | `version=4` | `version: 4` |
| snell-v6 | `version=6` | 跳过 | 跳过 |
| mieru | 跳过 | `mieru, …` | `type: mieru` |

- snell-v5 向 shadowrocket / clash 降级写 `version=4` 是安全的：snell v5 的线路协议向下兼容 v4 客户端。
- snell-v6 在 shadowrocket / clash 上直接**跳过**（该节点不出现在这两种输出的 `[Proxy]`/`proxies` 列表里），而不是降级：mihomo/Clash.Meta 的实现对 `version: 6` 会直接报错 `snell version error: 6`，一旦降级失败会导致整份订阅解析失败；而 v6 没有像 v5 那样向 v4 兼容的回退协议。跳过只影响 v6 节点本身，订阅里的其它节点不受影响。
- 不提供 `snell://` 分享链接（订阅渲染、Custom nodes 粘贴解析均不支持）：snell 目前没有事实标准的分享链接格式——生态里最主要的转换器 Sub-Store 对 snell 分享链接零支持，已知的两种私有格式互不兼容，因此本项目既不生成也不解析 `snell://`。

## 模板

模板描述流量如何分流。内置模板只读 —— 克隆一份再自定义。编辑器有 **表单（Form）** 模式和 **原始 JSON（Raw JSON）** 模式，外加一个实时 **预览（Preview）** 面板（选择目标格式即可查看渲染结果）。

- **服务组** —— 使用固定的 dler.io/oixCloud 分组及规则集；编辑器可排除服务组，核心 Proxy / Domestic / Others / Auto 保留。
- **自定义规则（Custom rules）** —— 每行一条 `TYPE,VALUE,policy`，例如 `DOMAIN-SUFFIX,example.com,DIRECT`。自定义规则先于内置业务规则，Surge 的加密 DNS 专用规则优先于自定义业务规则。
- **兼容旧 JSON 字段** —— `categories`、`final`、`include_auto_select` 仍可解析，但不控制固定模板的输出。默认兜底为 Surge `FINAL,Others,dns-failed` / Clash `MATCH,Others`；不要以为修改旧 `final` 字段就已启用阻断兜底。
- **DNS 组** —— Surge / Clash 自动增加 `Shepherd-DNS`，只包含实际可渲染节点（无节点时 REJECT），不含 DIRECT。与自定义名称冲突时自动追加 `-DNS`。请在客户端将其选择到预期境外出口；它不跟随普通 Proxy 组切换。Shadowrocket 的 DNS 使用主页所选节点。

## 节点命名与别名

默认情况下，订阅里每个节点名按 `<国旗> <服务器名> <协议>` 生成（如 `🇺🇸 Tokyo vless`）。在 xray / sing-box 的 inbound 上设置 **别名（Alias）** 后，该节点在所有订阅里直接用别名命名（原样输出，国旗/协议都不再自动添加，需要的话自己写进别名）。留空则回退默认命名。别名是 inbound 自身的属性，使用该 inbound 的所有订阅共用。

若多个节点解析出相同名字（别名重复，或别名与自动名撞车），渲染时自动追加 ` 2`/` 3` 去重，避免客户端因重名报错；去重覆盖入站节点和模板里的自定义分享链接节点。

## 自定义节点（分享链接）

模板里可以贴入**自定义节点** —— 每行一条分享链接，会被解析成节点，并与订阅选中的入站节点合并（一起进分组/分流，Surge 与 Clash 都会渲染）。支持 `vless://`、`ss://`、`vmess://`、`trojan://`、`hysteria2://`（或 `hy2://`）、`tuic://`、`anytls://`、`wg://`（或 `wireguard://`）。WireGuard 在 Clash 渲染为 `type: wireguard`，在 Surge 渲染为独立 `[WireGuard]` 段，在 ShadowRocket 渲染为内联 `[Proxy]` 行。链接 `#` 之后的名称作为节点名。在模板编辑器的 **Custom nodes (share links)** 文本框粘贴即可——解析成功的节点会立刻出现在实时预览里（没出现就说明那行没解析成功）。

注意：自定义节点属于**模板**，使用同一模板的所有订阅会共享这批节点。

## 自定义代理组（Custom groups）

模板可定义自己的命名代理组,每行 `名字 = 类型, 成员1, 成员2`(类型 = `select` 或 `url-test`)。成员是自由文本:节点名、`PROXY`/`DIRECT`/`REJECT`、`DEVICE:Name`(Surge Ponte 内网设备)、或其它组名。组成员**原样渲染**(不自动追加 DIRECT)。用自定义规则指向组名即可路由,例如:

- 组:`Home = select, DEVICE:HomeMac, DIRECT`
- 规则:`IP-CIDR,192.168.1.0/24,Home`

`DEVICE:` 是 **Surge 专有**(Ponte);**Clash 与 ShadowRocket 会自动过滤** `DEVICE:` 成员与以 `DEVICE:` 为策略的规则。跨格式使用的组请至少保留一个非 `DEVICE:` 成员(如 `DIRECT`)。

## 按格式区分的段落

不同客户端的配置段不同，因此这些字段彼此独立：

- **`[General]`**（仅 Surge / ShadowRocket）—— `key = value` 覆盖项，在客户端默认配置生成后按键替换，最终每个覆盖键仅出现一次。留空保留安全默认值；不接受段落标题、重复键。显式改回 `udp-policy-not-supported-behaviour = DIRECT` 或直连 DNS 会取消相应保护。
- **`[MITM]`**（仅 Surge / ShadowRocket）—— 原始 Surge MITM 指令，例如 `hostname = *.googlevideo.com`。留空 → 省略该段。Clash 没有 MITM，因此 `clash` 目标会忽略它。
- **`[URL Rewrite]`**（仅 Surge / ShadowRocket）—— 原始 Surge URL Rewrite 规则，每行 `正则 替换 模式`（模式如 `header`/`302`/`reject`），例如 `^https://example.com/x $1 header`。留空 → 省略该段。Clash 无对应,会忽略它。
- **`[Clash] general`**（仅 Clash）—— 单文档 YAML 对象，映射递归合并，数组/标量/null 替换；不再生成重复顶层键。例：
  ```yaml
  dns:
    listen: 127.0.0.1:1053
  ```
  只改监听地址会保留默认代理 DNS。留空保留模板原格式；非空合并会规范化 YAML 排版。重复键、多文档和非对象输入拒绝。最终配置再经过 UDP guard 与 YAML 校验，失败不会静默返回基础配置。自定义 rules 必须为可安全转换的规则序列；SUB-RULE、组内 PASS、包含否定 IP/provider 的可变匹配逻辑等不支持安全转换的控制流会明确拒绝生成（字面 PASS 规则仍支持）。只覆盖 proxy-groups 时，若默认 DNS 仍引用内部组，最终校验会拒绝缺失、循环或含直连后代的 DNS 组。Surge/ShadowRocket 忽略该字段。

## UDP 与 DNS 隐私默认值

这是**兼容性优先的分流配置**，不是全局匿名或“零直连 DNS”承诺：国内业务仍按原规则直连，仅将业务解析和节点引导分离。

- **Surge / Shadowrocket UDP**：不支持 UDP 的代理策略默认 REJECT，绝不为此自动转 DIRECT。可能影响不支持 UDP 节点上的通话、游戏；HTTP/3 可回退 TCP。
- **Mihomo UDP**：节点显式启用 UDP；每条可能走代理的规则后紧跟相同条件的 UDP REJECT。内核在节点不支持 UDP 而跳过原规则时，guard 阻止继续落入国内 DIRECT。正常支持 UDP 的节点及显式选 DIRECT 的组仍由原规则处理。自定义覆盖之后也会补 guard。
- **Surge DNS**：IP-literal Cloudflare / Google DoH，开启 `encrypted-dns-follow-outbound-mode`，最前 `PROTOCOL,DOH,Shepherd-DNS` 固定解析出口。仅对实际代理入口域名生成精确 `[Host] name = server:223.5.5.5`；SSH 跳板只映射跳板入口。这是避免域名节点解析循环所需的**传统 DNS 引导例外**。全局传统 DNS 还可用于 Surge 连通性检测。该映射解环行为要求支持它的 Surge 版本（Mac 5.6+；iOS 请按实际版本验证）。
- **Shadowrocket DNS**：主/备 IP-literal DoH 均带 `#proxy`；`proxy-dns-server` 单独采用直连加密 AliDNS 引导节点域名。不能删空 fallback，因为其空值可能等同系统 DNS。`dns-direct-system=false`，不通过 DNS 失败擅自改变国内业务规则。
- **Mihomo DNS**：业务 `nameserver` 显式指定 `#Shepherd-DNS`，不依赖国内 IP 分流决定 DNS 出口；`proxy-server-nameserver` / `default-nameserver` 使用直连加密 AliDNS 引导。默认 fake-ip、关闭 DNS IPv6，未强制开启系统 TUN。
- 移除原始商业模板的 `cloud-nodes.com` 专用解析、国内电商/媒体域名 Host 明文 DNS 覆盖；保留 LAN/router/system 解析例外。WireGuard 隧道内 DNS 使用 Cloudflare / Google。

**适用边界：**需要客户端规则模式，DNS 组/主页节点须有正确的预期出口；节点国旗不保证真实出口地区。仅系统 HTTP 代理不能接管所有 UDP、IPv6、应用内 DoH。Surge 的 `ipv6=false` 和 Mihomo 的 `dns.ipv6=false` 不是 OS 级 IPv6 防火墙。请自行启用适合平台的增强/TUN 模式，并核查浏览器 DNS/WebRTC。Shadowrocket 主备 DoH 同时失败后的闭源客户端行为仍需实机抓包验证，配置与语法校验不能证明无隐式系统回退。

**升级验收：**更新订阅后分别检查 HTTP IPv4/IPv6 出口、DNS leak、WebRTC 与请求日志；再测试代理失效、DoH 超时、节点域名冷缓存、Wi-Fi/移动网络切换。除了上述节点引导/连通性/LAN 例外，业务解析应经预期代理，失败不得改走本地明文 DNS。不要只看测试页出现“中国 DNS”就断言本地公网 IP 泄露。

## 分流分类

分类映射到 [blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script) 的远程规则集：Surge 目标引用 `.../rule/Surge/<Name>/<Name>.list`；Clash 目标定义 `rule-providers` 指向 `.../rule/Clash/<Name>/<Name>.yaml`（`behavior: classical`）。`Location:CN` 和 `Private` 使用原生匹配器（`GEOIP,CN`；Clash 把 `Private` 映射为 `GEOIP,PRIVATE`）。

## 示例

一个选了 `Telegram`（PROXY）和 `Location:CN`（DIRECT）、并开启 `include_auto_select` 的模板，渲染为 **Surge**：

```
[Proxy Group]
PROXY = select, Auto Select, <nodes>, DIRECT
Auto Select = url-test, <nodes>, url=http://www.gstatic.com/generate_204, interval=300
Telegram = select, PROXY, DIRECT, REJECT, <nodes>
Location:CN = select, DIRECT, PROXY, REJECT, <nodes>
[Rule]
RULE-SET,https://.../rule/Surge/Telegram/Telegram.list,Telegram
GEOIP,CN,Location:CN
FINAL,PROXY
```

…渲染为 **Clash**（YAML，节选）：

```yaml
proxy-groups:
  - {name: PROXY, type: select, proxies: [Auto Select, <nodes>]}
  - {name: Telegram, type: select, proxies: [PROXY, DIRECT, REJECT, <nodes>]}
rule-providers:
  Telegram: {type: http, behavior: classical, format: yaml, url: 'https://.../rule/Clash/Telegram/Telegram.yaml', path: ./ruleset/Telegram.yaml, interval: 86400}
rules:
  - RULE-SET,Telegram,Telegram
  - GEOIP,CN,Location:CN
  - MATCH,PROXY
```
