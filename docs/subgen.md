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

## 模板

模板描述流量如何分流。内置模板只读 —— 克隆一份再自定义。编辑器有 **表单（Form）** 模式和 **原始 JSON（Raw JSON）** 模式，外加一个实时 **预览（Preview）** 面板（选择目标格式即可查看渲染结果）。

- **分类（Categories）** —— 勾选某分类（Telegram、Streaming、Location:CN …）以分流其规则集。每个所选分类会生成一个 **以该分类命名的可切换代理组**；你选的 **策略（policy）** 是该组的默认成员，客户端可随时切换（例如把 Telegram 改走 DIRECT）。每个分类附带它所用的 blackmatrix7 GitHub 规则集地址。
- **自定义规则（Custom rules）** —— 每行一条 `TYPE,VALUE,policy`，例如 `DOMAIN-SUFFIX,example.com,DIRECT` 或 `IP-CIDR,10.0.0.0/24,PROXY`。这些保留各自的显式策略（不生成组）。
- **Final** —— 兜底策略（Surge 为 `FINAL`，Clash 为 `MATCH`）。
- **包含自动选择组（Include auto-select group）** —— 增加一个对所有节点做 url-test 的 `Auto Select` 组；主 `PROXY` 组会把它列在第一位。

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

- **`[General]`**（仅 Surge / ShadowRocket）—— 原始 Surge 指令，例如 `dns-server = 119.29.29.29, 223.5.5.5`。留空 → 默认 `bypass-system = true`。
- **`[MITM]`**（仅 Surge / ShadowRocket）—— 原始 Surge MITM 指令，例如 `hostname = *.googlevideo.com`。留空 → 省略该段。Clash 没有 MITM，因此 `clash` 目标会忽略它。
- **`[URL Rewrite]`**（仅 Surge / ShadowRocket）—— 原始 Surge URL Rewrite 规则，每行 `正则 替换 模式`（模式如 `header`/`302`/`reject`），例如 `^https://example.com/x $1 header`。留空 → 省略该段。Clash 无对应,会忽略它。
- **`[Clash] general`**（仅 Clash）—— 原始 Clash YAML 顶层键，例如：
  ```yaml
  mode: rule
  dns:
    enable: true
    nameserver: [223.5.5.5, 119.29.29.29]
  ```
  留空 → 默认 `mode: rule`。Surge/ShadowRocket 目标会忽略它。

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
