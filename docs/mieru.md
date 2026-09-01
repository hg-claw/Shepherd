# mieru 插件

**mieru** 插件在受管 Linux 主机上运行官方 [`mita`](https://github.com/enfein/mieru)（mieru 服务端），与 xray / sing-box 同级：独立 `plugin_hosts`、独立入站表、独立 systemd 单元 `shepherd-mieru`。

一台主机一个 mita 进程（`mita run` + `MITA_CONFIG_JSON_FILE`），多个入站对应多个 `users[]` 与 `portBindings[]`。不采用 NoBrand isolated-v2 的「每用户独立进程」。mita 只在 Linux 上运行。

## 部署

**插件 → mieru → Deploy**：从 [enfein/mieru](https://github.com/enfein/mieru/releases) 拉取 `mita_<ver>_linux_{amd64,arm64}.tar.gz`，安装为 `/usr/local/bin/shepherd-mita`，配置写到 `/etc/shepherd-mieru/server.json`。单元设置 `MITA_INSECURE_UDS=1`（不创建官方 `mita` 系统用户；Shepherd 不走 UDS RPC）。

## 入站

每个入站 = 一个 mita 用户：

| 字段 | 默认（对齐 NoBrand Balanced） |
|---|---|
| protocol | `TCP`（也可 `UDP` / `BOTH`） |
| MTU | 1400 |
| multiplexing | `MULTIPLEXING_OFF`（只进客户端分享链接） |
| handshake | `HANDSHAKE_NO_WAIT`（只进客户端分享链接） |

`BOTH`：TCP 监听 `port`，UDP 监听 `port+1`。用户名/密码 1–64 字节，不能含控制字符。

分享链接为官方简单格式 `mierus://user:pass@host?port=N&protocol=TCP&...`。Clash/mihomo 渲染 `type: mieru`（含 `handshake-mode`）；ShadowRocket 渲染 `[Proxy]` 的 `mieru` 行。Surge 跳过（无原生支持）。

## 明确不做（v1）

每用户独立 mita 进程、配额/到期/tc 限速、Traffic Pattern / Low Entropy、中继拓扑、流量采样。
