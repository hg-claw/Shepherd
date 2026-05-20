# xray 流量监控 — 设计文档

**状态：** 草案（2026-05-19）
**基线：** Phase 3c-1 已合并（xray 单进程多 inbound 模型，每个 inbound 有稳定 tag）
**所属阶段：** Phase 3c-2（xray 流量监控，按 inbound/outbound tag 维度采样、存储、展示）

---

## §1 范围

### 1.1 交付物

- **xray config 调整**：每台 xray 节点的渲染 config 中注入固定的 `api` inbound（监听 unix socket）和 `stats` + `policy.system` block
- **Agent 采样器**：新包 `internal/agent/xraysampler/`，每 30s 调用 `xray api` CLI 子命令拉取所有 counter，差分计算 Δbytes，通过现有 WS 通道上报 server
- **WS envelope**：新 envelope type `xray.traffic`，batch 携带当次周期所有 tag 的上行/下行增量
- **Server 端 ingest**：`telemetrysvc` 新增 `TrafficIngest` 方法，解析 `xray.traffic` envelope，写入 `xray_traffic_raw` 表
- **SQLite 三层表**：`xray_traffic_raw`（30s / 24h）、`xray_traffic_minute`（1min / 7d）、`xray_traffic_hour`（1h / 90d）
- **Rollup 任务**：server 启动时挂两个 ticker goroutine，raw→minute 和 minute→hour
- **Retention 任务**：扩展现有 `telemetrysvc.Retention`，清理三张流量表的过期数据
- **HTTP API**：`GET /api/admin/plugins/xray/traffic` + batch variant
- **UI**：HostsTab 每行加 sparkline（最近 1h），单 inbound 详情抽屉（时间范围切换 + 上下行 stack chart）

### 1.2 明确不做

- **per-user（email）流量切分**：v1 只到 (server_id, tag) 粒度，user-level 归入 §13 后续
- **实时流速（< 1s）**：最细粒度 30s；sub-second 需要 eBPF 或 kernel tap，不在本 spec 范围
- **P95 / 直方图 / 异常告警**：只存 SUM(bytes)，无分布统计；无阈值告警
- **导出 Prometheus / Grafana**：不引入任何外部可观测性系统
- **跨 server 聚合视图**：如"所有 landing 节点合并流量"——v1 不做，每 server 独立展示
- **历史流量查询 API 的访问控制细粒度**：继承现有 admin-only 鉴权，无 per-plugin 权限模型

### 1.3 关键约束

- **采样在 agent**：agent 与 xray 同机；拉 local unix socket，不让 server 主动轮询每台 host
- **30s 采样周期**：与现有 telemetry 采样周期一致，共用 WS 连接，不单独建信道
- **sqlite 单库**：继承现有存储决策；流量表与 telemetry 表在同一 db 文件
- **agent 与 xray 不同机的退化**：理论上 xray 和 agent 必须同机（deploy 流程保证），如果 socket 不存在则采样静默跳过，不影响 agent 主循环
- **xray restart 导致 counter 归零**：采样器检测到当前值 < 上次快照值时，此次 Δ 记为 0（不写负值）

---

## §2 数据模型

### 2.1 三层表 DDL

```sql
-- 原始 30s 样本，保留 24h
CREATE TABLE IF NOT EXISTS xray_traffic_raw (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,  -- 采样时刻，UTC，精确到秒
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS xray_traffic_raw_srv_tag_ts
    ON xray_traffic_raw (server_id, tag, ts);
CREATE INDEX IF NOT EXISTS xray_traffic_raw_ts
    ON xray_traffic_raw (ts);  -- 供 retention 按 ts 清理

-- 1min 聚合，保留 7d
CREATE TABLE IF NOT EXISTS xray_traffic_minute (
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,  -- bucket 起始时刻（truncate to minute），UTC
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS xray_traffic_minute_ts
    ON xray_traffic_minute (ts);

-- 1h 聚合，保留 90d
CREATE TABLE IF NOT EXISTS xray_traffic_hour (
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,  -- bucket 起始时刻（truncate to hour），UTC
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS xray_traffic_hour_ts
    ON xray_traffic_hour (ts);
```

### 2.2 数据形状

每行语义：`(server_id, tag, kind, ts)` 的一个时间窗口内通过该 tag 的**增量**字节数。

- `tag`：与 Phase 3c-1 inbound/outbound tag 对应，如 `"vless-reality-8443"`、`"direct"`
- `kind`：`"inbound"` 或 `"outbound"`
- `bytes_up`：对应 xray stats key 中的 `uplink` counter 在该周期的 Δ 值
- `bytes_down`：对应 `downlink` counter 的 Δ 值
- rollup 是简单 `SUM(bytes_up)` / `SUM(bytes_down)`，没有 avg/max

xray stats key 格式（来自 xray stats API）：

```
inbound>>>vless-reality-8443>>>traffic>>>uplink
inbound>>>vless-reality-8443>>>traffic>>>downlink
outbound>>>direct>>>traffic>>>uplink
outbound>>>direct>>>traffic>>>downlink
```

### 2.3 存储量估算

假设单台 server 有 10 个 inbound + 3 个 outbound = 13 个 tag，每个 tag 一条 raw 样本/30s：

| 分辨率 | 每 server 每天行数 | 保留期 | 总行数/server |
|--------|-------------------|--------|--------------|
| raw (30s) | 13 tag × 2 kind × 2880 = 74,880 | 24h | ~74,880 |
| minute (1min) | 13 × 2 × 1440 = 37,440 | 7d | ~262,080 |
| hour (1h) | 13 × 2 × 24 = 624 | 90d | ~56,160 |

每行约 80 字节（含索引开销约 150 字节），单 server 稳态占用：

- raw：~11 MB
- minute：~39 MB
- hour：~8 MB
- **合计约 58 MB / server / 稳态**，可接受。

---

## §3 xray config 调整

### 3.1 必须注入的 api inbound

每台 xray 节点的 config.json 中，Phase 3c-1 renderer（`internal/plugins/xray/config.go` 的 `renderMultiInbound` 或等效函数）在生成最终 config 时**总是**追加以下 inbound，用户不可关闭：

```json
{
  "listen": "unix:/var/run/shepherd-xray-api.sock",
  "protocol": "dokodemo-door",
  "settings": {
    "address": "127.0.0.1"
  },
  "tag": "__shepherd_api__",
  "sniffing": { "enabled": false }
}
```

同时追加 `ApiHandler` 服务声明（xray v1.8+ 格式）：

```json
"api": {
  "tag": "__shepherd_api__",
  "services": ["StatsService"]
}
```

socket 路径固定为 `/var/run/shepherd-xray-api.sock`；agent 采样器（§4）使用同一路径。

### 3.2 全局 stats block

```json
"stats": {},
"policy": {
  "system": {
    "statsInboundUplink":    true,
    "statsInboundDownlink":  true,
    "statsOutboundUplink":   true,
    "statsOutboundDownlink": true
  }
}
```

stats + policy.system 控制 xray 内部是否为每个 inbound/outbound 计数；api block 控制是否对外暴露查询接口。两者必须同时存在。

### 3.3 v1 不启用 per-user stats

`policy.levels` 中不设 `statsUserUplink / statsUserDownlink`，避免 xray 为每个 user UUID 单独计数带来的内存开销。

### 3.4 与 Phase 3c-1 renderer 的集成点

Phase 3c-1 renderer 函数签名（伪示意）：

```go
func RenderMultiInbound(req MultiInboundRequest) ([]byte, error)
```

本 spec 要求 `RenderMultiInbound` 在返回前**无条件**调用一个私有辅助函数 `injectStatsAndAPI(cfg map[string]any)` 注入上述三个 block（`api`、`stats`、`policy`）并把 `__shepherd_api__` inbound 追加到 `inbounds` 数组末尾。这样任何入口（模板渲染 / raw JSON 导入）都不会遗漏。

已有的单 inbound 渲染路径（`renderVLESSReality` 等）在本 spec 范围内**不**注入 stats——它们是 Phase 3b 遗留，等 3c-1 全面切到多 inbound 模型后再统一迁移。**本 spec 假设 3c-1 已合并，所有新部署走 `RenderMultiInbound`。**

---

## §4 Agent 采样器

### 4.1 模块位置

```
internal/agent/xraysampler/
    sampler.go       # 主结构 Sampler + Run loop
    parse.go         # 解析 xray api stats 输出
    sampler_test.go  # 单测（fake CLI / fake socket output）
    parse_test.go
```

### 4.2 工作循环

```go
type Sampler struct {
    SocketPath  string        // 默认 /var/run/shepherd-xray-api.sock
    Interval    time.Duration // 默认 30s
    Send        func(agentapi.Envelope) error
    prev        map[statKey]int64 // 上次快照：tag+kind+direction -> cumulative bytes
    prevExists  bool
}

type statKey struct {
    Tag  string // e.g. "vless-reality-8443"
    Kind string // "inbound" | "outbound"
    Dir  string // "up" | "down"
}
```

每个 tick：

1. 调用 `queryStats(socketPath)` → 返回 `map[statKey]int64`（累计值）
2. 如果 socket 不存在 / xray 未启动 → 跳过，保留 `prevExists = false`
3. 如果 `prevExists == false`（首次或上次失败）→ 存快照，`prevExists = true`，**不上报**（无法计算 Δ）
4. 否则计算 `delta[k] = max(0, cur[k] - prev[k])`（max 保护 xray restart 归零）
5. 按 (tag, kind) 合并 delta，构造 `[]XrayTrafficSample`
6. 打包 envelope，调用 `Send`
7. 更新 `prev = cur`

### 4.3 CLI vs gRPC 取舍

选择 **CLI（`xray api statsquery`）**：

| | CLI | gRPC |
|--|-----|------|
| 依赖 | 无（复用 xray binary） | 需要 import xray proto，Go mod 引入大量 gRPC 依赖 |
| 启动开销 | 每 30s fork 一次 xray 子进程（约 20ms） | 长连接，无 fork |
| 维护 | 接口稳定（xray 1.8+ 的 `xray api` 是公开 CLI） | proto 变更需同步更新 |
| 实现复杂度 | exec.Command + 解析文本/JSON | 需要 grpc.Dial + proto codegen |

**结论：CLI。** 30s 一次 fork 开销在 20ms 量级，完全可接受。

调用示例：

```bash
xray api statsquery \
    --server=unix:/var/run/shepherd-xray-api.sock \
    --reset=false \
    --pattern=""
```

输出为 JSON 数组，每条形如：

```json
{"name": "inbound>>>vless-reality-8443>>>traffic>>>uplink", "value": 1234567}
```

`parse.go` 解析 `name` 字段：按 `>>>` 分割，`parts[0]`=kind，`parts[1]`=tag，`parts[3]`=direction（uplink/downlink）。

### 4.4 异常处理

| 情况 | 处理 |
|------|------|
| socket 文件不存在 | 静默跳过；`prevExists` 不清零（保留上次快照，待 xray 恢复后继续差分） |
| `xray api` 命令 exit code != 0 | 同上，log.Printf 级别 warn |
| 某个 counter 当前值 < 上次快照值 | `delta = 0`（xray restart 归零）；不上报负值 |
| 所有 delta 均为 0 | 仍上报（服务端依赖这些零值样本来判断"xray 在线但无流量"） |
| WS 未连接时 `Send` 失败 | 丢弃此次数据；下一周期数据自然包含更大的累计 Δ（不补传） |

### 4.5 启动时机

Agent 在 `dialAndRun` 成功建立 WS 连接后，启动一个独立 goroutine 运行 `Sampler.Run(ctx)`。`Sampler` 不依赖 WS 是否在线——`Send` 失败时静默丢弃（见 4.4）。

`xraysampler` 包通过构建标签或配置项控制是否编译进 agent：默认**总是**编译，socket 不存在时自然空转，不影响 agent 功能。

在 `wsclient.Client` 中新增字段：

```go
TrafficSampler *xraysampler.Sampler // nil 表示禁用
```

`dialAndRun` 的 stop goroutine 结构里：

```go
if c.TrafficSampler != nil {
    go c.TrafficSampler.Run(samplerCtx)
}
```

---

## §5 WS envelope + ingest

### 5.1 新 envelope 类型

在 `internal/agentapi/types.go` 新增：

```go
// TypeXrayTraffic 是 agent → server 方向的 xray 流量样本 batch。
const TypeXrayTraffic = "xray.traffic"

// XrayTrafficSample 是单个 (tag, kind) 在一个 30s 周期内的增量字节数。
type XrayTrafficSample struct {
    Tag      string    `json:"tag"`       // inbound/outbound tag，e.g. "vless-reality-8443"
    Kind     string    `json:"kind"`      // "inbound" | "outbound"
    TS       time.Time `json:"ts"`        // 采样时刻，UTC
    BytesUp  int64     `json:"bytes_up"`  // 上行增量字节（Δ）
    BytesDown int64    `json:"bytes_down"` // 下行增量字节（Δ）
}

// XrayTrafficBatch 是单次 WS 帧携带的所有 tag 样本。
type XrayTrafficBatch struct {
    Samples []XrayTrafficSample `json:"samples"`
}
```

Wire 格式示例（WS text frame）：

```json
{
  "type": "xray.traffic",
  "p": {
    "samples": [
      {"tag": "vless-reality-8443", "kind": "inbound",  "ts": "2026-05-19T10:00:30Z", "bytes_up": 102400, "bytes_down": 512000},
      {"tag": "vmess-ws-443",       "kind": "inbound",  "ts": "2026-05-19T10:00:30Z", "bytes_up": 0,      "bytes_down": 0},
      {"tag": "direct",             "kind": "outbound", "ts": "2026-05-19T10:00:30Z", "bytes_up": 89000,  "bytes_down": 430000}
    ]
  }
}
```

### 5.2 Batch 上报

每 30s tick 的所有 tag（包括零值）打成一个 `XrayTrafficBatch` 作为单个 WS frame 发出。按 10 个 tag 估算，每帧约 800 字节，远低于 WebSocket 默认 frame limit，无需分片。

### 5.3 Server 端 ingest handler

在 `internal/telemetrysvc/ingest.go` 的 `HandleFrame` switch 中新增分支：

```go
case agentapi.TypeXrayTraffic:
    var batch agentapi.XrayTrafficBatch
    if err := env.Decode(&batch); err != nil {
        log.Printf("xray.traffic decode (server=%d): %v", serverID, err)
        return
    }
    if err := i.WriteTrafficBatch(ctx, serverID, batch.Samples); err != nil {
        log.Printf("xray.traffic write (server=%d): %v", serverID, err)
    }
```

`WriteTrafficBatch` 方法：

```go
func (i *Ingest) WriteTrafficBatch(ctx context.Context, serverID int64, samples []agentapi.XrayTrafficSample) error {
    tx, err := i.DB.BeginTxx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()
    stmt, err := tx.PrepareContext(ctx, `
        INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
        VALUES ($1, $2, $3, $4, $5, $6)`)
    if err != nil {
        return err
    }
    defer stmt.Close()
    for _, s := range samples {
        if _, err := stmt.ExecContext(ctx, serverID, s.Tag, s.Kind, s.TS.UTC(), s.BytesUp, s.BytesDown); err != nil {
            return err
        }
    }
    return tx.Commit()
}
```

### 5.4 ACK 协议

v1 策略：**不 ACK，不补传**。

- server 写入成功：静默
- server 写入失败（DB 错误）：log.Printf，agent 不感知；下一周期自然上报更新后的 Δ（包含了未能入库那段时间的字节）
- agent WS 断线：Sampler.Run 继续 tick，`Send` 返回错误，数据丢弃；重连后 Δ 包含断线期间的累计量

这意味着 WS 断线期间的样本精度下降（多个 30s 的流量被合并进一个 Δ），但总量正确。v1 可接受。

---

## §6 Rollup 任务

### 6.1 触发

在 server 启动时，与现有 `telemetrysvc.Rollup` 平行启动一个 `TrafficRollup`：

```go
type TrafficRollup struct {
    DB             *sqlx.DB
    MinuteInterval time.Duration // 默认 1min
    HourInterval   time.Duration // 默认 1h
}

func (r *TrafficRollup) Run(ctx context.Context) {
    minuteTicker := time.NewTicker(r.MinuteInterval)
    hourTicker   := time.NewTicker(r.HourInterval)
    defer minuteTicker.Stop()
    defer hourTicker.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-minuteTicker.C:
            if err := r.rollupRawToMinute(ctx); err != nil {
                log.Printf("traffic rollup raw->minute: %v", err)
            }
        case <-hourTicker.C:
            if err := r.rollupMinuteToHour(ctx); err != nil {
                log.Printf("traffic rollup minute->hour: %v", err)
            }
        }
    }
}
```

### 6.2 Rollup SQL

**raw → minute**（每分钟运行，仅处理已关闭的 bucket）：

```sql
INSERT INTO xray_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
SELECT
    server_id,
    tag,
    kind,
    strftime('%Y-%m-%dT%H:%M:00Z', ts) AS ts,  -- truncate to minute
    SUM(bytes_up),
    SUM(bytes_down)
FROM xray_traffic_raw
WHERE ts < strftime('%Y-%m-%dT%H:%M:00Z', 'now')  -- 只处理当前分钟之前的 bucket
GROUP BY server_id, tag, kind, strftime('%Y-%m-%dT%H:%M:00Z', ts)
ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
    bytes_up   = excluded.bytes_up,
    bytes_down = excluded.bytes_down;
```

**minute → hour**（每小时运行，仅处理已关闭的 bucket）：

```sql
INSERT INTO xray_traffic_hour (server_id, tag, kind, ts, bytes_up, bytes_down)
SELECT
    server_id,
    tag,
    kind,
    strftime('%Y-%m-%dT%H:00:00Z', ts) AS ts,  -- truncate to hour
    SUM(bytes_up),
    SUM(bytes_down)
FROM xray_traffic_minute
WHERE ts < strftime('%Y-%m-%dT%H:00:00Z', 'now')  -- 只处理当前小时之前的 bucket
GROUP BY server_id, tag, kind, strftime('%Y-%m-%dT%H:00:00Z', ts)
ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
    bytes_up   = excluded.bytes_up,
    bytes_down = excluded.bytes_down;
```

`ON CONFLICT DO UPDATE` 保证同一 bucket 被 rollup 多次时幂等：用最新聚合值覆盖（正确，因为 raw 表里的行数不会减少）。

### 6.3 旧数据清理

扩展 `telemetrysvc.Retention.Tick`，追加三张流量表的清理：

```go
{"traffic_raw_24h",    "xray_traffic_raw",    24 * time.Hour},
{"traffic_minute_7d",  "xray_traffic_minute", 7 * 24 * time.Hour},
{"traffic_hour_90d",   "xray_traffic_hour",   90 * 24 * time.Hour},
```

使用同一 `DELETE FROM <table> WHERE ts < $1` 语句，cutoff = now() - retention。三张表各自有 `ts` 索引（§2.1），全表扫描不会发生。

### 6.4 并发安全

- `rollupRawToMinute` 和 `rollupMinuteToHour` 各自在**单事务**内执行 `INSERT ... ON CONFLICT DO UPDATE`，天然幂等
- 两个 goroutine（minute 和 hour ticker）可能同时运行，但操作不同的源表和目标表，无行级冲突
- sqlite WAL 模式（现有配置）支持并发读写，无需额外锁

---

## §7 API

### 7.1 单 tag 时序查询

```
GET /api/admin/plugins/xray/traffic
```

Query 参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `server_id` | int | 是 | server 数字 ID |
| `tag` | string | 是 | inbound/outbound tag |
| `kind` | string | 否 | `inbound`\|`outbound`，不填则两种都返回 |
| `from` | RFC3339 | 是 | 时间范围起点 |
| `to` | RFC3339 | 是 | 时间范围终点 |
| `resolution` | string | 否 | `raw`\|`minute`\|`hour`；不填则自动选择（见 7.3） |

### 7.2 响应形状

```json
{
  "server_id": 3,
  "tag": "vless-reality-8443",
  "kind": "inbound",
  "resolution": "minute",
  "points": [
    {"ts": "2026-05-19T09:00:00Z", "bytes_up": 204800, "bytes_down": 1048576},
    {"ts": "2026-05-19T09:01:00Z", "bytes_up": 153600, "bytes_down": 819200},
    {"ts": "2026-05-19T09:02:00Z", "bytes_up": 0,      "bytes_down": 0}
  ]
}
```

`points` 按 `ts` 升序排列。空时段的点**不补零**（由 UI 侧处理稀疏序列）。

对应 SQL（以 minute 分辨率为例）：

```sql
SELECT ts, bytes_up, bytes_down
FROM xray_traffic_minute
WHERE server_id = $1
  AND tag  = $2
  AND kind = $3
  AND ts BETWEEN $4 AND $5
ORDER BY ts ASC;
```

### 7.3 自动分辨率选择

服务端根据 `to - from` 自动选择分辨率：

| 时间跨度 | 自动选择 | 说明 |
|----------|----------|------|
| ≤ 2h | `raw` | 最近 2h，sparkline 精度最高 |
| ≤ 7d | `minute` | 最多 7d，1min 粒度 |
| > 7d | `hour` | 最多 90d，1h 粒度 |

若 `resolution` 参数明确指定，跳过自动选择，直接查对应表。如果请求 `raw` 但时间跨度超过 24h，server 返回 `400 Bad Request`（raw 表只保留 24h）。

### 7.4 Batch 端点

```
GET /api/admin/plugins/xray/traffic/batch
```

Query 参数：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `server_id` | int | 是 | server 数字 ID |
| `tags` | string（逗号分隔） | 是 | 一次查多个 tag，如 `vless-reality-8443,vmess-ws-443` |
| `kind` | string | 否 | 同上 |
| `from` | RFC3339 | 是 | 时间范围起点 |
| `to` | RFC3339 | 是 | 时间范围终点 |
| `resolution` | string | 否 | 同上，自动选择规则与 7.3 一致 |

响应：

```json
{
  "resolution": "raw",
  "series": [
    {
      "tag": "vless-reality-8443",
      "kind": "inbound",
      "points": [{"ts": "...", "bytes_up": 102400, "bytes_down": 512000}, ...]
    },
    {
      "tag": "vmess-ws-443",
      "kind": "inbound",
      "points": [...]
    }
  ]
}
```

这是 HostsTab sparkline 预加载使用的端点——页面加载时一次拉取所有 inbound 最近 1h 的 raw 数据，避免 N 个独立请求。

---

## §8 UI

### 8.1 HostsTab 行内 sparkline

Phase 3c-1 引入的 **InboundsTab**（或 HostsTab 下的 inbound 列表）每行末尾新增一个 **Traffic** 列，展示最近 1h 的 `bytes_up + bytes_down` 之和的 sparkline（折线，宽约 80px × 高 28px）。

数据来源：页面加载时调用 `GET /api/admin/plugins/xray/traffic/batch?server_id=X&tags=<all>&from=now-1h&to=now&resolution=raw`，结果按 tag 分发到各行。

```tsx
// 伪示意，放在 InboundRow 组件内
<TrafficSparkline
  points={trafficByTag[row.tag]?.points ?? []}
  width={80}
  height={28}
/>
```

`TrafficSparkline` 是纯 SVG 实现（无第三方库），根据 `points` 数组计算 polyline 坐标。

### 8.2 单 inbound 详情抽屉

在 InboundsTab 中点击某 inbound 行，从右侧滑出一个 **Sheet**（shadcn/ui `<Sheet>`），展示：

- **标题**：`{tag}` 的流量详情
- **时间范围选择器**（4 个按钮）：1h / 24h / 7d / 30d
- **Stack bar/area chart**：X 轴为时间，Y 轴为字节数，上行（蓝）和下行（绿）堆叠展示
- **累计统计**：所选时间范围内 total bytes_up 和 bytes_down

时间范围与分辨率的对应：

| 选择 | from | resolution |
|------|------|------------|
| 1h | now-1h | raw |
| 24h | now-24h | raw（raw 保留 24h，刚好覆盖） |
| 7d | now-7d | minute |
| 30d | now-30d | hour |

chart 实现选用 **recharts**（项目已在用或可引入，bundle gzip ~45KB，接受）。仅使用 `<AreaChart>` 和 `<Tooltip>`，不引入 chart.js / d3 全量包。

```tsx
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

<ResponsiveContainer width="100%" height={200}>
  <AreaChart data={points}>
    <XAxis dataKey="ts" tickFormatter={formatTime} />
    <YAxis tickFormatter={formatBytes} />
    <Tooltip formatter={formatBytes} />
    <Area type="monotone" dataKey="bytes_up"   stackId="1" fill="#3b82f6" stroke="#3b82f6" />
    <Area type="monotone" dataKey="bytes_down" stackId="1" fill="#22c55e" stroke="#22c55e" />
  </AreaChart>
</ResponsiveContainer>
```

### 8.3 Server 级 Overview tile（可选，v1 低优先级）

在 xray ConfigTab 或专属 TrafficTab（视 Phase 3c-1 tab 结构而定）顶部放一个 overview section，展示**当前 server 的所有 inbound 24h 流量总量排行**（Top N）。数据来自 `GET /api/admin/plugins/xray/traffic/batch?resolution=raw&from=now-24h&to=now` 对所有 tag 求 sum，前端聚合排序。

此 tile 标记为 **v1 可选**——如果 InboundsTab sparkline 已经足够直观，可延后实现。

### 8.4 Bundle 大小

- recharts（若新引入）：gzip ~45KB。项目已有 @tanstack/react-query 等，整体 bundle 可接受
- `TrafficSparkline`（自绘 SVG）：< 1KB，无额外依赖
- **不引入** chart.js（gzip ~60KB）或 d3 全套（gzip ~90KB）

---

## §9 生命周期

### 9.1 Inbound 删除后历史样本

inbound 删除后，`xray_traffic_*` 表中以该 tag 为键的历史行**保留到正常 retention 过期**，不主动提前删除。原因：

1. tag 是软属性（字符串），无 FK 约束，删除 inbound 记录不触发 cascade
2. 保留历史便于审计
3. 等 retention 自然过期（最长 90d），无需额外清理任务

UI 侧：如果某 tag 在 inbound 列表里已不存在但 traffic 历史仍有记录，sparkline 行不显示（因为没有对应的 inbound 行），历史数据在 DB 里静默存活直至过期。

### 9.2 Server 删除后样本

`xray_traffic_raw`、`xray_traffic_minute`、`xray_traffic_hour` 三表均有：

```sql
server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE
```

删除 `servers` 行时，三张流量表的所有对应行**自动 CASCADE 删除**。无需应用层额外处理。

### 9.3 Xray 重启 / 升级时 counter 归零

- **采样器行为**（§4.4 已详述）：检测到当前值 < prev → delta = 0，本次 δ 记为 0 字节，prev 更新为当前值，下一 tick 正常差分
- **UI 表现**：chart 上对应时刻的柱/面积为零，不会出现负值或假冒峰值
- **rollup 影响**：那 30s 的零值样本被聚合进 minute/hour 时仍为 0，不影响整体曲线准确性

---

## §10 迁移

3c-2 引入 3 张新表，全部纯增量，不修改任何已有表。

迁移文件：`internal/plugins/xray/migrations/0004_traffic.up.sql`（Phase 3c-1 占用了 0003，本 spec 顺位 0004）：

```sql
-- §2.1 DDL 完整内容（见上）
CREATE TABLE IF NOT EXISTS xray_traffic_raw   (...);
CREATE TABLE IF NOT EXISTS xray_traffic_minute (...);
CREATE TABLE IF NOT EXISTS xray_traffic_hour   (...);
CREATE INDEX IF NOT EXISTS ...（全部索引）
```

对应 `0004_traffic.down.sql`：

```sql
DROP TABLE IF EXISTS xray_traffic_hour;
DROP TABLE IF EXISTS xray_traffic_minute;
DROP TABLE IF EXISTS xray_traffic_raw;
```

现有 DB 无任何流量表，零冲突。迁移工具（现有 goose 或等效机制）按版本号顺序运行，无需额外操作。

---

## §11 测试矩阵

### 11.1 采样器单测（`xraysampler/sampler_test.go`）

| 测试名 | 场景 | 验证点 |
|--------|------|--------|
| `TestFirstTickNoReport` | 首次 tick，无 prev | Send 不被调用 |
| `TestSecondTickDelta` | 第二次 tick，counter 增加 | Send 被调用，delta 正确 |
| `TestXrayRestartZeroDelta` | 当前值 < prev（归零） | delta = 0，不发负值 |
| `TestSocketMissingSkip` | socket 不存在 | 跳过，不调用 Send，不 panic |
| `TestAllZeroDeltaStillSends` | 流量为零 | Send 仍被调用（上报零值） |

fake CLI 实现：在测试中将 `queryFunc` 注入为返回预设 JSON 的函数，不依赖真实 xray binary。

### 11.2 解析单测（`xraysampler/parse_test.go`）

| 输入 | 期望输出 |
|------|---------|
| `inbound>>>vless-reality-8443>>>traffic>>>uplink` | `{Tag:"vless-reality-8443", Kind:"inbound", Dir:"up"}` |
| `outbound>>>direct>>>traffic>>>downlink` | `{Tag:"direct", Kind:"outbound", Dir:"down"}` |
| `__shepherd_api__>>>traffic>>>uplink`（api inbound 本身） | 解析后被采样器过滤掉（tag 以 `__shepherd_` 开头的跳过） |
| 格式不合法的字符串 | 返回 error，不 panic |

### 11.3 Ingest 单测（`telemetrysvc/ingest_test.go`）

| 测试 | 验证点 |
|------|--------|
| `TestWriteTrafficBatch` | 3 个样本写入 raw 表，行数和字段值正确 |
| `TestWriteTrafficBatchEmptySamples` | 空 batch 不报错，行数为 0 |
| `TestHandleFrameXrayTraffic` | HandleFrame 正确路由到 WriteTrafficBatch |

### 11.4 Rollup 单测（`telemetrysvc/rollup_test.go`）

| 测试 | 验证点 |
|------|--------|
| `TestTrafficRollupRawToMinute` | 写入 4 条 raw 样本（同一 minute bucket） → Tick → minute 表 1 行，bytes 为 4 条之和 |
| `TestTrafficRollupMinuteToHour` | 写入 60 条 minute 样本（同一 hour bucket） → Tick → hour 表 1 行，bytes 正确 |
| `TestTrafficRollupIdempotent` | 同一 bucket 跑两次 rollup → ON CONFLICT DO UPDATE，行数不变，值不重复叠加 |
| `TestTrafficRollupOpenBucketSkipped` | 当前分钟内的 raw 样本不被 rollup（bucket 未关闭） |

### 11.5 UI 单测

| 组件 | 测试工具 | 验证点 |
|------|----------|--------|
| `TrafficSparkline` | vitest + @testing-library/react | 传入 3 个点，渲染的 `<polyline>` points 属性非空 |
| `InboundRow` sparkline 集成 | mock API（msw），`queryFn` 返回 batch 数据 | sparkline 列正确渲染，不报错 |
| `TrafficDrawer` 时间范围切换 | mock API | 切换 "7d" 后请求参数包含 `resolution=minute` |

### 11.6 手工 Smoke

1. 部署一台 xray（Phase 3c-1 多 inbound 模型），验证 `/var/run/shepherd-xray-api.sock` 存在
2. 在 agent 机上运行 `xray api statsquery --server=unix:/var/run/shepherd-xray-api.sock`，确认输出 JSON 含 `inbound>>>` 条目
3. 等待 30s → 在 Shepherd UI HostsTab 刷新，确认 sparkline 列有折线
4. 用任意客户端通过该 inbound 发送约 1MB 流量
5. 等待 30s → sparkline 出现流量峰值
6. 等待 60s → 查看 `xray_traffic_minute` 表，确认有聚合行，bytes_up + bytes_down > 0
7. 手动 `systemctl restart xray-shepherd` → 等 30s → 确认 sparkline 无负值跳变

---

## §12 已确认的取舍

| 决策 | 取舍 | 理由 |
|------|------|------|
| 采样用 CLI（`xray api statsquery`） | 每 30s fork 一次进程 vs 长连接 gRPC | 避免引入 xray proto 依赖；CLI 接口稳定；20ms 开销可接受 |
| 存储用 sqlite 三层表 | 无时序DB特性（TTL原生支持、降采样） | 与项目整体存储决策一致；retention/rollup 用 ticker 自己做 |
| v1 不 ACK / 不补传 | WS 断线时丢失最多 1 个 30s 窗口的精度（总量仍正确） | 流量监控允许少量精度损失；实现简单 |
| 不做 per-user 流量切分 | 无法按用户计费或限速 | v1 需求不涉及；xray user-level stats 会带来内存开销 |
| `__shepherd_api__` tag 过滤 | api inbound 本身的流量（采样请求）被排除在统计外 | 避免统计噪声；api inbound 流量纯属 Shepherd 内部开销 |
| sparkline 自绘 SVG | 不使用 recharts 做 sparkline，只在详情抽屉用 | 减小 bundle；sparkline 只需 polyline，无需完整图表库 |
| rollup 用 ON CONFLICT DO UPDATE | 幂等覆盖而非跳过 | raw 表中随时可能追加数据使聚合变化；覆盖比跳过更准确 |

---

## §13 后续可能

- **per-user（email）流量切分**：启用 `policy.levels` user stats，xray stats key 格式变为 `user>>>{email}>>>traffic>>>uplink`；需要新维度列 `user_id` 或 `email`，大幅增加行数，估算为当前 10x
- **实时流速（< 5s）**：需要 xray 侧支持推送（gRPC stream）或 eBPF tap；WebSocket streaming 到 UI；目前 30s 精度不支持
- **P95 / 直方图 / 异常检测**：需要每个 30s 窗口内的分布（不只是总量）；建议引入 HdrHistogram 或类似结构
- **告警阈值**：当某 inbound 1h 流量超过 X GB 时发送 webhook / Telegram 通知；需要 alerting 子系统
- **导出 Prometheus**：`/metrics` 端点按 tag 暴露 `xray_inbound_bytes_total` counter；适配 Grafana
- **跨 server 聚合视图**：所有 landing 的总出站流量趋势图；需要按 `kind=outbound` 跨 server 汇总 API
- **relay 流量透传可视化**：relay inbound 流量 vs relay→landing outbound 流量对比，用于调试丢包 / 延迟
