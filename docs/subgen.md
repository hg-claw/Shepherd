# Subscriptions (subgen)

The **Subscriptions** plugin generates client subscription configs from your
existing xray and sing-box inbounds, with category-based routing. Clients poll a
per-subscription URL; you control routing and output format with templates.

## Subscriptions

A subscription bundles a set of inbound nodes + a template + a token. Create one
under **Plugins → Subscriptions**, then:

- **Edit nodes** — pick which xray/sing-box inbounds it exposes.
- **Subscription URL** — `/sub/<token>?target=<format>`. Copy it into your client.
- **Rotate token** — invalidates the old URL and issues a new one.
- **Enabled** — a disabled subscription returns 404.

## Output formats

Set the `target` query parameter:

| `target` | Client | Format |
|----------|--------|--------|
| `surge` | Surge | Surge `.conf` |
| `shadowrocket` | ShadowRocket | Surge `.conf` (ShadowRocket reads it) |
| `clash` | Clash.Meta / mihomo | YAML |

Example: `https://your-host/sub/abcdef…?target=clash`

## Templates

A template describes how traffic is routed. Built-in templates are read-only —
clone one to customize. The editor has a **Form** mode and a **Raw JSON** mode,
plus a live **Preview** pane (pick a target to see the rendered config).

- **Categories** — check a category (Telegram, Streaming, Location:CN, …) to
  route its rule-sets. Each selected category becomes a **switchable proxy
  group** named after it; the **policy** you pick is the group's default member,
  and clients can switch it (e.g. send Telegram via DIRECT). Each category ships
  the blackmatrix7 GitHub rule-set addresses it uses.
- **Custom rules** — one `TYPE,VALUE,policy` per line, e.g.
  `DOMAIN-SUFFIX,example.com,DIRECT` or `IP-CIDR,10.0.0.0/24,PROXY`. These keep
  their explicit policy (no group is generated).
- **Final** — the catch-all policy (Surge `FINAL`, Clash `MATCH`).
- **Include auto-select group** — adds an `Auto Select` url-test group over all
  nodes; the main `PROXY` group lists it first.

## Per-format sections

Different clients have different config sections, so these are kept separate:

- **`[General]`** (Surge / ShadowRocket only) — raw Surge directives, e.g.
  `dns-server = 119.29.29.29, 223.5.5.5`. Empty → default `bypass-system = true`.
- **`[MITM]`** (Surge / ShadowRocket only) — raw Surge MITM directives, e.g.
  `hostname = *.googlevideo.com`. Empty → the section is omitted. Clash has no
  MITM, so this is ignored for the `clash` target.
- **`[Clash] general`** (Clash only) — raw Clash YAML top-level keys, e.g.:
  ```yaml
  mode: rule
  dns:
    enable: true
    nameserver: [223.5.5.5, 119.29.29.29]
  ```
  Empty → default `mode: rule`. This is ignored for the Surge/ShadowRocket
  targets.

## Routing categories

Categories map to remote rule-sets from
[blackmatrix7/ios_rule_script](https://github.com/blackmatrix7/ios_rule_script):
Surge targets reference `.../rule/Surge/<Name>/<Name>.list`; the Clash target
defines `rule-providers` pointing at `.../rule/Clash/<Name>/<Name>.yaml`
(`behavior: classical`). `Location:CN` and `Private` use native matchers
(`GEOIP,CN`; Clash maps `Private` to `GEOIP,PRIVATE`).

## Example

A template selecting `Telegram` (PROXY) and `Location:CN` (DIRECT), with
`include_auto_select` on, renders for **Surge**:

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

…and for **Clash** (YAML, abridged):

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
