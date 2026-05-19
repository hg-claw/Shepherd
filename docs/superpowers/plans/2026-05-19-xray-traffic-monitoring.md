# xray Traffic Monitoring (Phase 3c-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect per-inbound/outbound traffic bytes from xray's stats API every 30 s on each agent, ship deltas to the server via the existing WS channel, roll up into 3 SQLite tables (raw/minute/hour), and display sparklines per inbound row plus a drill-down area chart with time-range switching.

**Architecture:** Agent forks `xray api statsquery` every 30 s over a unix socket injected by the xray config renderer, computes Δbytes in memory, and sends a new `xray.traffic` WS envelope; the server ingest handler writes to `xray_traffic_raw`, two ticker goroutines roll up raw→minute and minute→hour, a separate retention ticker prunes old rows, and two new HTTP endpoints expose time-series to the React UI which renders sparklines with the existing `Sparkline` component and a drill-down `<Sheet>` using recharts `AreaChart`.

**Tech Stack:** Go 1.25 / sqlx / SQLite / xray stats API via CLI / React 19 + TS + Tailwind + recharts. Baseline: Phase 3c-1 merged.

---

## File Map

**Create:**
- `internal/plugins/xray/migrations/0004_traffic.up.sql`
- `internal/plugins/xray/migrations/0004_traffic.down.sql`
- `internal/agent/xraysampler/parse.go`
- `internal/agent/xraysampler/parse_test.go`
- `internal/agent/xraysampler/sampler.go`
- `internal/agent/xraysampler/sampler_test.go`
- `internal/agent/xraysampler/testdata/v18_output.json`
- `internal/agent/xraysampler/testdata/v19_output.json`
- `internal/telemetrysvc/traffic_ingest.go`
- `internal/telemetrysvc/traffic_ingest_test.go`
- `internal/telemetrysvc/traffic_rollup.go`
- `internal/telemetrysvc/traffic_rollup_test.go`
- `web/src/pages/admin/plugins/xray/TrafficDrawer.tsx`

**Modify:**
- `internal/plugins/xray/migrations.go` — append `0004_traffic`
- `internal/plugins/xray/config.go` — inject api inbound + stats + policy into `RenderServerConfig` (3c-1 function)
- `internal/plugins/xray/config_test.go` — assert api inbound + stats block present
- `internal/agentapi/types.go` — add `TypeXrayTraffic`, `XrayTrafficSample`, `XrayTrafficBatch`
- `internal/telemetrysvc/ingest.go` — add `case agentapi.TypeXrayTraffic` dispatch branch
- `internal/telemetrysvc/retention.go` — add three traffic table cleanup entries
- `internal/agent/wsclient/client.go` — add `TrafficSampler *xraysampler.Sampler` field; start goroutine in `dialAndRun`
- `cmd/agent/main.go` — construct and wire `xraysampler.Sampler`
- `cmd/server/main.go` — start `TrafficRollup.Run` goroutine
- `internal/plugins/xray/routes.go` — add `GET /traffic` and `GET /traffic/batch` handlers
- `web/src/api/plugins.ts` — add `XrayTrafficPoint`, `XrayTrafficSeries`, `fetchXrayTraffic`, `fetchXrayTrafficBatch`
- `web/src/pages/admin/plugins/xray/HostsTab.tsx` — add Traffic sparkline column + drawer trigger
- `web/package.json` — add `recharts` dependency

---

## Task 1: Migration — three traffic tables

**Files:**
- Create: `internal/plugins/xray/migrations/0004_traffic.up.sql`
- Create: `internal/plugins/xray/migrations/0004_traffic.down.sql`
- Modify: `internal/plugins/xray/migrations.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/plugins/xray/xray_test.go` (or create `internal/plugins/xray/migration_0004_test.go`):

```go
package xray

import (
    "context"
    "path/filepath"
    "testing"
    "time"

    shepdb "github.com/hg-claw/Shepherd/internal/db"
    "github.com/hg-claw/Shepherd/internal/plugins"
)

func TestMigration0004_CreatesTrafficTables(t *testing.T) {
    dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
    d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
    if err != nil { t.Fatal(err) }
    t.Cleanup(func() { _ = d.Close() })
    if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil { t.Fatal(err) }

    // Seed server row for FK constraint
    d.MustExec(`INSERT INTO servers(id,name,created_at,updated_at) VALUES (?,?,?,?)`,
        1, "s1", time.Now(), time.Now())

    migs := loadMigrations()
    if err := plugins.RunPluginMigrations(context.Background(), d, "xray", migs); err != nil {
        t.Fatal(err)
    }

    for _, tbl := range []string{"xray_traffic_raw", "xray_traffic_minute", "xray_traffic_hour"} {
        var n int
        if err := d.Get(&n, "SELECT COUNT(*) FROM "+tbl); err != nil {
            t.Fatalf("table %s not found: %v", tbl, err)
        }
    }

    // Verify row can be inserted
    _, err = d.Exec(`INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
        VALUES (1, 'vless-reality-8443', 'inbound', datetime('now'), 1024, 2048)`)
    if err != nil {
        t.Fatalf("insert xray_traffic_raw: %v", err)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test -run TestMigration0004_CreatesTrafficTables ./internal/plugins/xray/...
```

Expected: FAIL — `loadMigrations` does not include `0004_traffic`, table not found.

- [ ] **Step 3: Create the up migration**

`internal/plugins/xray/migrations/0004_traffic.up.sql`:

```sql
-- raw 30s samples, retained 24h
CREATE TABLE IF NOT EXISTS xray_traffic_raw (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS xray_traffic_raw_srv_tag_ts
    ON xray_traffic_raw (server_id, tag, ts);
CREATE INDEX IF NOT EXISTS xray_traffic_raw_ts
    ON xray_traffic_raw (ts);

-- 1min aggregates, retained 7d
CREATE TABLE IF NOT EXISTS xray_traffic_minute (
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS xray_traffic_minute_ts
    ON xray_traffic_minute (ts);

-- 1h aggregates, retained 90d
CREATE TABLE IF NOT EXISTS xray_traffic_hour (
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS xray_traffic_hour_ts
    ON xray_traffic_hour (ts);
```

`internal/plugins/xray/migrations/0004_traffic.down.sql`:

```sql
DROP TABLE IF EXISTS xray_traffic_hour;
DROP TABLE IF EXISTS xray_traffic_minute;
DROP TABLE IF EXISTS xray_traffic_raw;
```

- [ ] **Step 4: Register the migration**

`internal/plugins/xray/migrations.go` — append `"0004_traffic.up.sql"` to the `names` slice:

```go
names := []string{
    "0001_xray.up.sql",
    "0002_topology.up.sql",
    "0004_traffic.up.sql",
}
```

(Note: 0003 is reserved for the multi-inbound migration from 3c-1.)

- [ ] **Step 5: Run test to verify PASS**

```bash
go test -run TestMigration0004_CreatesTrafficTables ./internal/plugins/xray/...
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/plugins/xray/migrations/0004_traffic.up.sql \
        internal/plugins/xray/migrations/0004_traffic.down.sql \
        internal/plugins/xray/migrations.go \
        internal/plugins/xray/migration_0004_test.go
git commit -m "feat(xray/migrations): add 0004_traffic tables (raw/minute/hour)"
```

---

## Task 2: xray config renderer — inject api inbound + stats block

**Files:**
- Modify: `internal/plugins/xray/config.go` (add `injectStatsAndAPI` helper, call from `RenderServerConfig`)
- Modify: `internal/plugins/xray/config_test.go` (or create alongside)

The spec says Phase 3c-1 introduces `RenderServerConfig(inbounds []InboundRow) ([]byte, error)`. At baseline (3c-1 merged), that function exists. This task adds the stats injection to it. If 3c-1 is not yet merged and `RenderServerConfig` does not exist, apply to `RenderTemplate` / `renderVLESSReality` as a fallback — but the spec explicitly states 3c-1 is the baseline, so `RenderServerConfig` is the target.

- [ ] **Step 1: Write the failing test**

Add to `internal/plugins/xray/config_test.go`:

```go
func TestRenderServerConfig_InjectsStatsAndAPIInbound(t *testing.T) {
    inbounds := []InboundRow{
        {
            ID: 1, ServerID: 1, Tag: "landing-aabbccdd", Port: 443, Role: "landing",
            Protocol: "vless-reality", UUID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            SNI: "www.example.com", PublicKey: "pubkey1", PrivateKey: "privkey1", ShortID: "aabb1122",
        },
    }
    out, err := RenderServerConfig(inbounds)
    if err != nil {
        t.Fatal(err)
    }
    var cfg map[string]any
    if err := json.Unmarshal(out, &cfg); err != nil {
        t.Fatal(err)
    }
    // stats block present
    if _, ok := cfg["stats"]; !ok {
        t.Error("missing 'stats' block")
    }
    // api block present with correct tag
    apiBlock, ok := cfg["api"].(map[string]any)
    if !ok {
        t.Fatal("missing 'api' block or wrong type")
    }
    if apiBlock["tag"] != "__shepherd_api__" {
        t.Errorf("api.tag = %v, want __shepherd_api__", apiBlock["tag"])
    }
    // __shepherd_api__ inbound present in inbounds array
    inbs, _ := cfg["inbounds"].([]any)
    found := false
    for _, ib := range inbs {
        m, _ := ib.(map[string]any)
        if m["tag"] == "__shepherd_api__" {
            found = true
            listen, _ := m["listen"].(string)
            if listen != "unix:/var/run/shepherd-xray-api.sock" {
                t.Errorf("api inbound listen = %q, want unix:/var/run/shepherd-xray-api.sock", listen)
            }
        }
    }
    if !found {
        t.Error("__shepherd_api__ inbound not injected into inbounds array")
    }
    // policy.system block present with all four stats flags
    policy, _ := cfg["policy"].(map[string]any)
    system, _ := policy["system"].(map[string]any)
    for _, key := range []string{"statsInboundUplink", "statsInboundDownlink", "statsOutboundUplink", "statsOutboundDownlink"} {
        if v, _ := system[key].(bool); !v {
            t.Errorf("policy.system.%s not true", key)
        }
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test -run TestRenderServerConfig_InjectsStatsAndAPIInbound ./internal/plugins/xray/...
```

Expected: FAIL — `RenderServerConfig` output does not contain `stats`, `api`, or `__shepherd_api__` inbound.

- [ ] **Step 3: Implement**

Add to `internal/plugins/xray/config.go` (before or after `RenderServerConfig`):

```go
// apiInboundTag is the reserved tag for the shepherd stats API inbound.
const apiInboundTag = "__shepherd_api__"

// apiSocketPath is the unix socket xray listens on for stats CLI queries.
const apiSocketPath = "unix:/var/run/shepherd-xray-api.sock"

// injectStatsAndAPI mutates cfg in-place to add the stats, api, and
// policy.system blocks, and appends the __shepherd_api__ dokodemo inbound.
// It is idempotent: calling it twice does not duplicate entries.
func injectStatsAndAPI(cfg map[string]any) {
    // stats block
    cfg["stats"] = map[string]any{}

    // api block
    cfg["api"] = map[string]any{
        "tag":      apiInboundTag,
        "services": []any{"StatsService"},
    }

    // policy.system block (merge into existing policy if any)
    policy, _ := cfg["policy"].(map[string]any)
    if policy == nil {
        policy = map[string]any{}
    }
    policy["system"] = map[string]any{
        "statsInboundUplink":    true,
        "statsInboundDownlink":  true,
        "statsOutboundUplink":   true,
        "statsOutboundDownlink": true,
    }
    cfg["policy"] = policy

    // append __shepherd_api__ inbound if not already present
    inbs, _ := cfg["inbounds"].([]any)
    for _, ib := range inbs {
        if m, ok := ib.(map[string]any); ok && m["tag"] == apiInboundTag {
            return // already injected
        }
    }
    apiInbound := map[string]any{
        "listen":   apiSocketPath,
        "protocol": "dokodemo-door",
        "settings": map[string]any{"address": "127.0.0.1"},
        "tag":      apiInboundTag,
        "sniffing": map[string]any{"enabled": false},
    }
    cfg["inbounds"] = append(inbs, apiInbound)
}
```

At the end of `RenderServerConfig`, just before `json.MarshalIndent`, add:

```go
    injectStatsAndAPI(cfg)
    return json.MarshalIndent(cfg, "", "  ")
```

(`cfg` is the `map[string]any` assembled by `RenderServerConfig`; its exact name matches whatever 3c-1 uses — adjust accordingly.)

- [ ] **Step 4: Run test to verify PASS**

```bash
go test -run TestRenderServerConfig ./internal/plugins/xray/...
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/config.go internal/plugins/xray/config_test.go
git commit -m "feat(xray/config): inject stats+api inbound into RenderServerConfig"
```

---

## Task 3: agentapi — new TrafficBatch envelope types

**Files:**
- Modify: `internal/agentapi/types.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/agentapi/envelope_test.go` (or create `internal/agentapi/traffic_test.go`):

```go
package agentapi

import (
    "testing"
    "time"
)

func TestXrayTrafficBatch_RoundTrip(t *testing.T) {
    batch := XrayTrafficBatch{
        Samples: []XrayTrafficSample{
            {Tag: "vless-reality-8443", Kind: "inbound", TS: time.Date(2026, 5, 19, 10, 0, 30, 0, time.UTC), BytesUp: 102400, BytesDown: 512000},
            {Tag: "direct", Kind: "outbound", TS: time.Date(2026, 5, 19, 10, 0, 30, 0, time.UTC), BytesUp: 89000, BytesDown: 0},
        },
    }
    env, err := Frame(TypeXrayTraffic, batch)
    if err != nil {
        t.Fatal(err)
    }
    if env.Type != TypeXrayTraffic {
        t.Errorf("type = %q, want %q", env.Type, TypeXrayTraffic)
    }
    var got XrayTrafficBatch
    if err := env.Decode(&got); err != nil {
        t.Fatal(err)
    }
    if len(got.Samples) != 2 {
        t.Fatalf("samples = %d, want 2", len(got.Samples))
    }
    if got.Samples[0].BytesUp != 102400 {
        t.Errorf("BytesUp = %d, want 102400", got.Samples[0].BytesUp)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test -run TestXrayTrafficBatch_RoundTrip ./internal/agentapi/...
```

Expected: FAIL — `TypeXrayTraffic`, `XrayTrafficSample`, `XrayTrafficBatch` undefined.

- [ ] **Step 3: Implement**

Append to `internal/agentapi/types.go`:

```go
// TypeXrayTraffic is the agent→server envelope type for xray traffic samples.
const TypeXrayTraffic = "xray.traffic"

// XrayTrafficSample is a single (tag, kind) traffic delta for one 30s window.
type XrayTrafficSample struct {
    Tag       string    `json:"tag"`        // e.g. "vless-reality-8443"
    Kind      string    `json:"kind"`       // "inbound" | "outbound"
    TS        time.Time `json:"ts"`         // sample timestamp, UTC
    BytesUp   int64     `json:"bytes_up"`   // uplink delta bytes
    BytesDown int64     `json:"bytes_down"` // downlink delta bytes
}

// XrayTrafficBatch is the payload of a TypeXrayTraffic envelope.
// One batch is sent per 30s tick and covers all observed tags.
type XrayTrafficBatch struct {
    Samples []XrayTrafficSample `json:"samples"`
}
```

- [ ] **Step 4: Run test to verify PASS**

```bash
go test -run TestXrayTrafficBatch_RoundTrip ./internal/agentapi/...
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/agentapi/types.go internal/agentapi/traffic_test.go
git commit -m "feat(agentapi): add TypeXrayTraffic envelope types"
```

---

## Task 4: xraysampler/parse — parse xray stats CLI output

**Files:**
- Create: `internal/agent/xraysampler/parse.go`
- Create: `internal/agent/xraysampler/parse_test.go`
- Create: `internal/agent/xraysampler/testdata/v18_output.json`
- Create: `internal/agent/xraysampler/testdata/v19_output.json`

- [ ] **Step 1: Write the failing test**

`internal/agent/xraysampler/parse_test.go`:

```go
package xraysampler

import (
    "os"
    "testing"
)

func TestParseStats_V18Format(t *testing.T) {
    data, err := os.ReadFile("testdata/v18_output.json")
    if err != nil {
        t.Fatal(err)
    }
    got, err := ParseStats(data)
    if err != nil {
        t.Fatal(err)
    }
    key := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
    if v, ok := got[key]; !ok || v != 1234567 {
        t.Errorf("v18 uplink = %d (ok=%v), want 1234567", v, ok)
    }
    key2 := statKey{Tag: "direct", Kind: "outbound", Dir: "down"}
    if v, ok := got[key2]; !ok || v != 9876543 {
        t.Errorf("v18 outbound downlink = %d (ok=%v), want 9876543", v, ok)
    }
}

func TestParseStats_V19Format(t *testing.T) {
    data, err := os.ReadFile("testdata/v19_output.json")
    if err != nil {
        t.Fatal(err)
    }
    got, err := ParseStats(data)
    if err != nil {
        t.Fatal(err)
    }
    key := statKey{Tag: "vmess-ws-443", Kind: "inbound", Dir: "down"}
    if v, ok := got[key]; !ok || v != 555000 {
        t.Errorf("v19 downlink = %d (ok=%v), want 555000", v, ok)
    }
}

func TestParseStats_SkipsAPIInbound(t *testing.T) {
    raw := []byte(`[{"name":"inbound>>>__shepherd_api__>>>traffic>>>uplink","value":100}]`)
    got, err := ParseStats(raw)
    if err != nil {
        t.Fatal(err)
    }
    if len(got) != 0 {
        t.Errorf("expected empty map (api inbound filtered), got %d entries", len(got))
    }
}

func TestParseStats_InvalidName(t *testing.T) {
    raw := []byte(`[{"name":"not-valid-format","value":1}]`)
    // invalid names are skipped, not fatal
    got, err := ParseStats(raw)
    if err != nil {
        t.Fatal(err)
    }
    if len(got) != 0 {
        t.Errorf("expected empty map for invalid name, got %d", len(got))
    }
}

func TestParseStats_EmptyArray(t *testing.T) {
    got, err := ParseStats([]byte(`[]`))
    if err != nil {
        t.Fatal(err)
    }
    if len(got) != 0 {
        t.Errorf("expected empty map, got %d", len(got))
    }
}
```

- [ ] **Step 2: Create test fixture files**

`internal/agent/xraysampler/testdata/v18_output.json`:

```json
[
  {"name": "inbound>>>vless-reality-8443>>>traffic>>>uplink",   "value": 1234567},
  {"name": "inbound>>>vless-reality-8443>>>traffic>>>downlink",  "value": 7654321},
  {"name": "outbound>>>direct>>>traffic>>>uplink",              "value": 111111},
  {"name": "outbound>>>direct>>>traffic>>>downlink",            "value": 9876543}
]
```

`internal/agent/xraysampler/testdata/v19_output.json`:

```json
{
  "stat": [
    {"name": "inbound>>>vmess-ws-443>>>traffic>>>uplink",    "value": "123000"},
    {"name": "inbound>>>vmess-ws-443>>>traffic>>>downlink",  "value": "555000"},
    {"name": "outbound>>>direct>>>traffic>>>uplink",         "value": "99000"},
    {"name": "outbound>>>direct>>>traffic>>>downlink",       "value": "44000"}
  ]
}
```

(v1.9+ wraps the array in an object with key `"stat"` and stringifies the values.)

- [ ] **Step 3: Run test to verify it fails**

```bash
go test -run TestParseStats ./internal/agent/xraysampler/...
```

Expected: FAIL — package does not exist yet.

- [ ] **Step 4: Implement**

`internal/agent/xraysampler/parse.go`:

```go
package xraysampler

import (
    "encoding/json"
    "fmt"
    "strconv"
    "strings"
)

// statKey identifies a unique (tag, kind, direction) counter.
type statKey struct {
    Tag  string // e.g. "vless-reality-8443"
    Kind string // "inbound" | "outbound"
    Dir  string // "up" | "down"
}

type rawStat struct {
    Name  string          `json:"name"`
    Value json.RawMessage `json:"value"`
}

// ParseStats handles both xray v1.8.x output (JSON array) and v1.9+ output
// (JSON object with a "stat" key whose values may be strings or numbers).
// Tags starting with "__shepherd_" are silently filtered out.
func ParseStats(data []byte) (map[statKey]int64, error) {
    // Try array form first (v1.8.x).
    var arr []rawStat
    if json.Unmarshal(data, &arr) == nil {
        return parseStatSlice(arr)
    }
    // Try object form (v1.9+).
    var obj struct {
        Stat []rawStat `json:"stat"`
    }
    if err := json.Unmarshal(data, &obj); err != nil {
        return nil, fmt.Errorf("xraysampler: cannot parse stats output: %w", err)
    }
    return parseStatSlice(obj.Stat)
}

func parseStatSlice(stats []rawStat) (map[statKey]int64, error) {
    out := make(map[statKey]int64, len(stats))
    for _, s := range stats {
        k, val, err := parseStat(s)
        if err != nil {
            // skip malformed entries silently
            continue
        }
        out[k] = val
    }
    return out, nil
}

// parseStat parses one stat entry. Returns an error for malformed entries.
// Filtered tags (api inbound) return error to trigger skip.
func parseStat(s rawStat) (statKey, int64, error) {
    parts := strings.Split(s.Name, ">>>")
    if len(parts) != 4 {
        return statKey{}, 0, fmt.Errorf("unexpected stat name format: %q", s.Name)
    }
    kind := parts[0]   // "inbound" | "outbound"
    tag  := parts[1]   // e.g. "vless-reality-8443"
    // parts[2] == "traffic"
    dirRaw := parts[3] // "uplink" | "downlink"

    if strings.HasPrefix(tag, "__shepherd_") {
        return statKey{}, 0, fmt.Errorf("filtered shepherd-internal tag %q", tag)
    }

    dir := "up"
    if dirRaw == "downlink" {
        dir = "down"
    }

    // Value may be a JSON number or a JSON string (v1.9+).
    var val int64
    // Try number first.
    if err := json.Unmarshal(s.Value, &val); err != nil {
        // Try string.
        var sv string
        if err2 := json.Unmarshal(s.Value, &sv); err2 != nil {
            return statKey{}, 0, fmt.Errorf("cannot parse value for %q: %w", s.Name, err)
        }
        val, err = strconv.ParseInt(sv, 10, 64)
        if err != nil {
            return statKey{}, 0, fmt.Errorf("cannot parse string value for %q: %w", s.Name, err)
        }
    }

    return statKey{Tag: tag, Kind: kind, Dir: dir}, val, nil
}
```

- [ ] **Step 5: Run test to verify PASS**

```bash
go test -run TestParseStats ./internal/agent/xraysampler/...
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/agent/xraysampler/parse.go \
        internal/agent/xraysampler/parse_test.go \
        internal/agent/xraysampler/testdata/
git commit -m "feat(xraysampler): add parser for xray stats CLI output (v1.8/v1.9)"
```

---

## Task 5: xraysampler/sampler — 30s loop, delta computation, Send

**Files:**
- Create: `internal/agent/xraysampler/sampler.go`
- Create: `internal/agent/xraysampler/sampler_test.go`

- [ ] **Step 1: Write the failing test**

`internal/agent/xraysampler/sampler_test.go`:

```go
package xraysampler

import (
    "context"
    "testing"
    "time"

    "github.com/hg-claw/Shepherd/internal/agentapi"
)

// fakeQuery returns a map with preset counters.
func fakeQuery(m map[statKey]int64) func(socketPath string) (map[statKey]int64, error) {
    return func(_ string) (map[statKey]int64, error) { return m, nil }
}

func fakeErr(err error) func(socketPath string) (map[statKey]int64, error) {
    return func(_ string) (map[statKey]int64, error) { return nil, err }
}

func collectSends(s *Sampler, n int) []agentapi.XrayTrafficBatch {
    var got []agentapi.XrayTrafficBatch
    s.Send = func(env agentapi.Envelope) error {
        var b agentapi.XrayTrafficBatch
        _ = env.Decode(&b)
        got = append(got, b)
        return nil
    }
    return got
}

func runTicks(s *Sampler, queries []map[statKey]int64) []agentapi.XrayTrafficBatch {
    var sent []agentapi.XrayTrafficBatch
    s.Send = func(env agentapi.Envelope) error {
        var b agentapi.XrayTrafficBatch
        _ = env.Decode(&b)
        sent = append(sent, b)
        return nil
    }
    for _, q := range queries {
        s.queryFunc = fakeQuery(q)
        s.tick(context.Background())
    }
    return sent
}

func TestFirstTickNoReport(t *testing.T) {
    s := &Sampler{SocketPath: "/fake.sock", Interval: time.Second}
    key := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
    sent := runTicks(s, []map[statKey]int64{{key: 1000}})
    if len(sent) != 0 {
        t.Errorf("first tick should not send; got %d batches", len(sent))
    }
}

func TestSecondTickDelta(t *testing.T) {
    s := &Sampler{SocketPath: "/fake.sock", Interval: time.Second}
    k := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
    kd := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "down"}
    sent := runTicks(s, []map[statKey]int64{
        {k: 1000, kd: 5000},
        {k: 1500, kd: 8000},
    })
    if len(sent) != 1 {
        t.Fatalf("expected 1 batch after second tick, got %d", len(sent))
    }
    if len(sent[0].Samples) != 1 {
        t.Fatalf("expected 1 sample (one tag), got %d", len(sent[0].Samples))
    }
    sample := sent[0].Samples[0]
    if sample.BytesUp != 500 {
        t.Errorf("BytesUp = %d, want 500 (delta)", sample.BytesUp)
    }
    if sample.BytesDown != 3000 {
        t.Errorf("BytesDown = %d, want 3000 (delta)", sample.BytesDown)
    }
}

func TestXrayRestartZeroDelta(t *testing.T) {
    s := &Sampler{SocketPath: "/fake.sock", Interval: time.Second}
    k := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
    sent := runTicks(s, []map[statKey]int64{
        {k: 5000},
        {k: 200}, // counter went backwards (xray restart)
    })
    if len(sent) != 1 {
        t.Fatalf("expected 1 batch, got %d", len(sent))
    }
    if sent[0].Samples[0].BytesUp != 0 {
        t.Errorf("BytesUp = %d after restart, want 0", sent[0].Samples[0].BytesUp)
    }
}

func TestSocketMissingSkip(t *testing.T) {
    s := &Sampler{SocketPath: "/fake.sock", Interval: time.Second}
    var sendCalled bool
    s.Send = func(_ agentapi.Envelope) error { sendCalled = true; return nil }
    s.queryFunc = fakeErr(fmt.Errorf("socket not found"))
    s.tick(context.Background())
    if sendCalled {
        t.Error("Send should not be called when query fails")
    }
}

func TestAllZeroDeltaStillSends(t *testing.T) {
    s := &Sampler{SocketPath: "/fake.sock", Interval: time.Second}
    k := statKey{Tag: "vless-reality-8443", Kind: "inbound", Dir: "up"}
    sent := runTicks(s, []map[statKey]int64{
        {k: 1000},
        {k: 1000}, // no change — delta = 0
    })
    if len(sent) != 1 {
        t.Fatalf("expected 1 batch even for zero delta, got %d", len(sent))
    }
    if sent[0].Samples[0].BytesUp != 0 {
        t.Errorf("BytesUp = %d, want 0", sent[0].Samples[0].BytesUp)
    }
}
```

(Add `"fmt"` import in the test file.)

- [ ] **Step 2: Run test to verify it fails**

```bash
go test -run TestFirstTickNoReport ./internal/agent/xraysampler/...
```

Expected: FAIL — `Sampler`, `tick`, `queryFunc` undefined.

- [ ] **Step 3: Implement**

`internal/agent/xraysampler/sampler.go`:

```go
package xraysampler

import (
    "context"
    "fmt"
    "log"
    "os/exec"
    "strings"
    "time"

    "github.com/hg-claw/Shepherd/internal/agentapi"
)

// Sampler collects xray traffic stats every Interval and emits XrayTrafficBatch envelopes.
type Sampler struct {
    SocketPath string        // unix socket path; default /var/run/shepherd-xray-api.sock
    Interval   time.Duration // sampling interval; default 30s
    Send       func(agentapi.Envelope) error

    // queryFunc is replaceable in tests; production uses queryStatsViaCLI.
    queryFunc func(socketPath string) (map[statKey]int64, error)

    prev       map[statKey]int64
    prevExists bool
}

func (s *Sampler) socketPath() string {
    if s.SocketPath != "" {
        return s.SocketPath
    }
    return "/var/run/shepherd-xray-api.sock"
}

func (s *Sampler) interval() time.Duration {
    if s.Interval > 0 {
        return s.Interval
    }
    return 30 * time.Second
}

func (s *Sampler) query(socketPath string) (map[statKey]int64, error) {
    if s.queryFunc != nil {
        return s.queryFunc(socketPath)
    }
    return queryStatsViaCLI(socketPath)
}

// Run blocks until ctx is canceled, ticking every Interval.
func (s *Sampler) Run(ctx context.Context) {
    t := time.NewTicker(s.interval())
    defer t.Stop()
    for {
        select {
        case <-ctx.Done():
            return
        case <-t.C:
            s.tick(ctx)
        }
    }
}

func (s *Sampler) tick(ctx context.Context) {
    cur, err := s.query(s.socketPath())
    if err != nil {
        log.Printf("xraysampler: query failed: %v", err)
        return
    }

    if !s.prevExists {
        s.prev = cur
        s.prevExists = true
        return // first tick: store snapshot, do not report
    }

    // Compute deltas keyed by (tag, kind).
    type tagKind struct{ Tag, Kind string }
    type upDown struct{ Up, Down int64 }
    deltas := map[tagKind]upDown{}

    for k, curVal := range cur {
        prevVal := s.prev[k]
        delta := curVal - prevVal
        if delta < 0 {
            delta = 0 // xray restart: counter reset
        }
        tk := tagKind{Tag: k.Tag, Kind: k.Kind}
        d := deltas[tk]
        if k.Dir == "up" {
            d.Up += delta
        } else {
            d.Down += delta
        }
        deltas[tk] = d
    }

    now := time.Now().UTC()
    samples := make([]agentapi.XrayTrafficSample, 0, len(deltas))
    for tk, d := range deltas {
        samples = append(samples, agentapi.XrayTrafficSample{
            Tag:       tk.Tag,
            Kind:      tk.Kind,
            TS:        now,
            BytesUp:   d.Up,
            BytesDown: d.Down,
        })
    }

    env, err := agentapi.Frame(agentapi.TypeXrayTraffic, agentapi.XrayTrafficBatch{Samples: samples})
    if err != nil {
        log.Printf("xraysampler: frame error: %v", err)
        s.prev = cur
        return
    }

    if s.Send != nil {
        if err := s.Send(env); err != nil {
            log.Printf("xraysampler: send failed (dropped): %v", err)
        }
    }

    s.prev = cur
}

// queryStatsViaCLI runs `xray api statsquery` against the unix socket.
func queryStatsViaCLI(socketPath string) (map[statKey]int64, error) {
    // socketPath is already in unix:// form; xray expects --server=unix:/path
    server := socketPath
    if !strings.HasPrefix(server, "unix:") {
        server = "unix:" + socketPath
    }
    out, err := exec.Command("xray", "api", "statsquery",
        fmt.Sprintf("--server=%s", server),
        "--reset=false",
        `--pattern=`,
    ).Output()
    if err != nil {
        return nil, fmt.Errorf("xray api statsquery: %w", err)
    }
    return ParseStats(out)
}
```

- [ ] **Step 4: Run test to verify PASS**

```bash
go test -run TestFirstTickNoReport -run TestSecondTickDelta -run TestXrayRestartZeroDelta -run TestSocketMissingSkip -run TestAllZeroDeltaStillSends ./internal/agent/xraysampler/...
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add internal/agent/xraysampler/sampler.go internal/agent/xraysampler/sampler_test.go
git commit -m "feat(xraysampler): 30s sampler loop with delta computation"
```

---

## Task 6: Wire sampler into agent — wsclient + cmd/agent/main.go

**Files:**
- Modify: `internal/agent/wsclient/client.go`
- Modify: `cmd/agent/main.go`

- [ ] **Step 1: Write the failing test**

Add to `internal/agent/wsclient/client_test.go` (append to existing file; verify it compiles):

```go
func TestClient_TrafficSamplerField_Compiles(t *testing.T) {
    c := &Client{}
    // Just verify the field exists and accepts a *xraysampler.Sampler
    // (compilation test — no runtime assertions needed here)
    _ = c.TrafficSampler
}
```

(Add `"github.com/hg-claw/Shepherd/internal/agent/xraysampler"` import if needed by the field type.)

- [ ] **Step 2: Run test to verify it fails**

```bash
go build ./internal/agent/wsclient/...
```

Expected: compile error — `TrafficSampler` field does not exist.

- [ ] **Step 3: Implement**

In `internal/agent/wsclient/client.go`:

1. Add import: `"github.com/hg-claw/Shepherd/internal/agent/xraysampler"`

2. Add field to `Client` struct (after `Hostname string`):

```go
// TrafficSampler, if non-nil, is started as a goroutine after each WS connect.
TrafficSampler *xraysampler.Sampler
```

3. In `dialAndRun`, after `go c.heartbeatLoop(stop)`, add:

```go
if c.TrafficSampler != nil {
    samplerCtx, samplerCancel := context.WithCancel(ctx)
    go func() {
        select {
        case <-stop:
            samplerCancel()
        case <-ctx.Done():
            samplerCancel()
        }
    }()
    go c.TrafficSampler.Run(samplerCtx)
}
```

4. Set the sampler's `Send` to the client's `Send` method after creation. This is done in `cmd/agent/main.go` (next step).

In `cmd/agent/main.go`, after `client := wsclient.New(...)`:

```go
trafficSampler := &xraysampler.Sampler{
    SocketPath: "/var/run/shepherd-xray-api.sock",
    Interval:   30 * time.Second,
    Send:       client.Send,
}
client.TrafficSampler = trafficSampler
```

Add import: `"github.com/hg-claw/Shepherd/internal/agent/xraysampler"`

- [ ] **Step 4: Run test to verify PASS**

```bash
go build ./cmd/agent/... && go test ./internal/agent/wsclient/...
```

Expected: builds clean, tests pass

- [ ] **Step 5: Commit**

```bash
git add internal/agent/wsclient/client.go cmd/agent/main.go
git commit -m "feat(agent): wire xraysampler into wsclient dialAndRun goroutine"
```

---

## Task 7: Server ingest — WriteTrafficBatch + HandleFrame dispatch

**Files:**
- Create: `internal/telemetrysvc/traffic_ingest.go`
- Create: `internal/telemetrysvc/traffic_ingest_test.go`
- Modify: `internal/telemetrysvc/ingest.go`

- [ ] **Step 1: Write the failing test**

`internal/telemetrysvc/traffic_ingest_test.go`:

```go
package telemetrysvc

import (
    "context"
    "testing"
    "time"

    "github.com/hg-claw/Shepherd/internal/agentapi"
    "github.com/hg-claw/Shepherd/internal/plugins"
    xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"
)

func newIngestWithTraffic(t *testing.T) (*Ingest, int64) {
    t.Helper()
    ing, sid := newIngest(t) // reuse helper from ingest_test.go
    // run xray plugin migrations to create traffic tables
    migs := xrayplugin.LoadMigrationsForTest()
    if err := plugins.RunPluginMigrations(context.Background(), ing.DB, "xray", migs); err != nil {
        t.Fatal(err)
    }
    return ing, sid
}

func TestWriteTrafficBatch_InsertsRows(t *testing.T) {
    ing, sid := newIngestWithTraffic(t)
    ctx := context.Background()
    now := time.Now().UTC().Truncate(time.Second)

    samples := []agentapi.XrayTrafficSample{
        {Tag: "vless-reality-8443", Kind: "inbound",  TS: now, BytesUp: 1024, BytesDown: 2048},
        {Tag: "vmess-ws-443",       Kind: "inbound",  TS: now, BytesUp: 512,  BytesDown: 1024},
        {Tag: "direct",             Kind: "outbound", TS: now, BytesUp: 300,  BytesDown: 400},
    }
    if err := ing.WriteTrafficBatch(ctx, sid, samples); err != nil {
        t.Fatal(err)
    }

    var n int
    if err := ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM xray_traffic_raw WHERE server_id=?", sid); err != nil {
        t.Fatal(err)
    }
    if n != 3 {
        t.Errorf("rows = %d, want 3", n)
    }
    var up int64
    _ = ing.DB.GetContext(ctx, &up, "SELECT bytes_up FROM xray_traffic_raw WHERE tag='vless-reality-8443'")
    if up != 1024 {
        t.Errorf("bytes_up = %d, want 1024", up)
    }
}

func TestWriteTrafficBatch_EmptySamples(t *testing.T) {
    ing, sid := newIngestWithTraffic(t)
    if err := ing.WriteTrafficBatch(context.Background(), sid, nil); err != nil {
        t.Fatal(err)
    }
    var n int
    _ = ing.DB.Get(&n, "SELECT COUNT(*) FROM xray_traffic_raw WHERE server_id=?", sid)
    if n != 0 {
        t.Errorf("rows = %d after empty batch, want 0", n)
    }
}

func TestHandleFrame_XrayTraffic(t *testing.T) {
    ing, sid := newIngestWithTraffic(t)
    ctx := context.Background()
    now := time.Now().UTC().Truncate(time.Second)

    batch := agentapi.XrayTrafficBatch{Samples: []agentapi.XrayTrafficSample{
        {Tag: "vless-reality-8443", Kind: "inbound", TS: now, BytesUp: 100, BytesDown: 200},
    }}
    env, _ := agentapi.Frame(agentapi.TypeXrayTraffic, batch)
    ing.HandleFrame(ctx, sid, env)

    var n int
    _ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM xray_traffic_raw WHERE server_id=?", sid)
    if n != 1 {
        t.Errorf("rows = %d after HandleFrame, want 1", n)
    }
}
```

Note: `xrayplugin.LoadMigrationsForTest()` is a package-level function to be exported from `internal/plugins/xray/migrations.go` (rename `loadMigrations` to `Migrations()` or add a test export — see Step 3).

- [ ] **Step 2: Run test to verify it fails**

```bash
go test -run TestWriteTrafficBatch ./internal/telemetrysvc/...
```

Expected: FAIL — `WriteTrafficBatch` undefined, traffic tables don't exist.

- [ ] **Step 3: Implement**

First, export the migration loader from `internal/plugins/xray/migrations.go` for test use:

```go
// Migrations returns the ordered list of xray plugin migrations.
// Exported so tests in other packages can apply migrations in a test DB.
func Migrations() []plugins.Migration { return loadMigrations() }
```

Then in `internal/telemetrysvc/traffic_ingest.go`:

```go
package telemetrysvc

import (
    "context"

    "github.com/hg-claw/Shepherd/internal/agentapi"
)

// WriteTrafficBatch inserts a slice of XrayTrafficSample rows into xray_traffic_raw
// within a single transaction. Empty slice is a no-op.
func (i *Ingest) WriteTrafficBatch(ctx context.Context, serverID int64, samples []agentapi.XrayTrafficSample) error {
    if len(samples) == 0 {
        return nil
    }
    tx, err := i.DB.BeginTxx(ctx, nil)
    if err != nil {
        return err
    }
    defer func() { _ = tx.Rollback() }()

    stmt, err := tx.PrepareContext(ctx, `
        INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
        VALUES ($1, $2, $3, $4, $5, $6)`)
    if err != nil {
        return err
    }
    defer func() { _ = stmt.Close() }()

    for _, s := range samples {
        if _, err := stmt.ExecContext(ctx, serverID, s.Tag, s.Kind, s.TS.UTC(), s.BytesUp, s.BytesDown); err != nil {
            return err
        }
    }
    return tx.Commit()
}
```

Then add the dispatch case to `internal/telemetrysvc/ingest.go`, inside `HandleFrame`'s switch:

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

In `traffic_ingest_test.go`, adjust the import to `xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"` and call `xrayplugin.Migrations()`.

- [ ] **Step 4: Run test to verify PASS**

```bash
go test -run TestWriteTrafficBatch -run TestHandleFrame_XrayTraffic ./internal/telemetrysvc/...
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/telemetrysvc/traffic_ingest.go \
        internal/telemetrysvc/traffic_ingest_test.go \
        internal/telemetrysvc/ingest.go \
        internal/plugins/xray/migrations.go
git commit -m "feat(telemetrysvc): WriteTrafficBatch + HandleFrame dispatch for xray.traffic"
```

---

## Task 8: TrafficRollup — raw→minute, minute→hour, retention entries

**Files:**
- Create: `internal/telemetrysvc/traffic_rollup.go`
- Create: `internal/telemetrysvc/traffic_rollup_test.go`
- Modify: `internal/telemetrysvc/retention.go`

- [ ] **Step 1: Write the failing test**

`internal/telemetrysvc/traffic_rollup_test.go`:

```go
package telemetrysvc

import (
    "context"
    "path/filepath"
    "testing"
    "time"

    shepdb "github.com/hg-claw/Shepherd/internal/db"
    "github.com/hg-claw/Shepherd/internal/plugins"
    xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"
)

func newRollupDB(t *testing.T) (*Ingest, int64) {
    t.Helper()
    dsn := "file:" + filepath.Join(t.TempDir(), "r.db") + "?_fk=1"
    d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
    t.Cleanup(func() { _ = d.Close() })
    _ = shepdb.Migrate(d, shepdb.DriverSQLite)
    _ = plugins.RunPluginMigrations(context.Background(), d, "xray", xrayplugin.Migrations())
    res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
    sid, _ := res.LastInsertId()
    return &Ingest{DB: d}, sid
}

func TestTrafficRollupRawToMinute(t *testing.T) {
    ing, sid := newRollupDB(t)
    ctx := context.Background()
    // Insert 4 raw samples all in the same minute bucket, 2 minutes ago.
    bucket := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Minute)
    for i := 0; i < 4; i++ {
        ts := bucket.Add(time.Duration(i) * 15 * time.Second)
        _, err := ing.DB.ExecContext(ctx,
            `INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
             VALUES (?, 'vless-reality-8443', 'inbound', ?, 1000, 2000)`, sid, ts)
        if err != nil {
            t.Fatal(err)
        }
    }

    r := &TrafficRollup{DB: ing.DB}
    if err := r.rollupRawToMinute(ctx); err != nil {
        t.Fatal(err)
    }

    var n int
    _ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM xray_traffic_minute WHERE server_id=?", sid)
    if n != 1 {
        t.Fatalf("xray_traffic_minute rows = %d, want 1", n)
    }
    var up, down int64
    _ = ing.DB.GetContext(ctx, &up,   "SELECT bytes_up   FROM xray_traffic_minute WHERE server_id=?", sid)
    _ = ing.DB.GetContext(ctx, &down, "SELECT bytes_down FROM xray_traffic_minute WHERE server_id=?", sid)
    if up != 4000 {
        t.Errorf("bytes_up = %d, want 4000 (4 × 1000)", up)
    }
    if down != 8000 {
        t.Errorf("bytes_down = %d, want 8000 (4 × 2000)", down)
    }
}

func TestTrafficRollupMinuteToHour(t *testing.T) {
    ing, sid := newRollupDB(t)
    ctx := context.Background()
    // Insert 60 minute rows all in the same hour bucket, 2 hours ago.
    bucket := time.Now().UTC().Add(-2 * time.Hour).Truncate(time.Hour)
    for i := 0; i < 60; i++ {
        ts := bucket.Add(time.Duration(i) * time.Minute)
        _, err := ing.DB.ExecContext(ctx,
            `INSERT INTO xray_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
             VALUES (?, 'vless-reality-8443', 'inbound', ?, 100, 200)
             ON CONFLICT DO NOTHING`, sid, ts)
        if err != nil {
            t.Fatal(err)
        }
    }

    r := &TrafficRollup{DB: ing.DB}
    if err := r.rollupMinuteToHour(ctx); err != nil {
        t.Fatal(err)
    }

    var up int64
    _ = ing.DB.GetContext(ctx, &up, "SELECT bytes_up FROM xray_traffic_hour WHERE server_id=?", sid)
    if up != 6000 {
        t.Errorf("bytes_up = %d, want 6000 (60 × 100)", up)
    }
}

func TestTrafficRollupIdempotent(t *testing.T) {
    ing, sid := newRollupDB(t)
    ctx := context.Background()
    bucket := time.Now().UTC().Add(-2 * time.Minute).Truncate(time.Minute)
    ing.DB.MustExec(
        `INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'vless-reality-8443', 'inbound', ?, 1000, 2000)`, sid, bucket)

    r := &TrafficRollup{DB: ing.DB}
    _ = r.rollupRawToMinute(ctx)
    _ = r.rollupRawToMinute(ctx) // second run: must not double-count

    var n int
    _ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM xray_traffic_minute WHERE server_id=?", sid)
    if n != 1 {
        t.Errorf("idempotent rollup duplicated rows: %d", n)
    }
}

func TestTrafficRollupOpenBucketSkipped(t *testing.T) {
    ing, sid := newRollupDB(t)
    ctx := context.Background()
    // Insert a raw sample timestamped "now" — bucket is still open.
    ing.DB.MustExec(
        `INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
         VALUES (?, 'vless-reality-8443', 'inbound', datetime('now'), 500, 1000)`, sid)

    r := &TrafficRollup{DB: ing.DB}
    _ = r.rollupRawToMinute(ctx)

    var n int
    _ = ing.DB.GetContext(ctx, &n, "SELECT COUNT(*) FROM xray_traffic_minute")
    if n != 0 {
        t.Errorf("open bucket was rolled up (rows=%d)", n)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test -run TestTrafficRollup ./internal/telemetrysvc/...
```

Expected: FAIL — `TrafficRollup` type undefined.

- [ ] **Step 3: Implement**

`internal/telemetrysvc/traffic_rollup.go`:

```go
package telemetrysvc

import (
    "context"
    "log"
    "time"

    "github.com/jmoiron/sqlx"
)

// TrafficRollup runs two periodic SQL rollups:
// raw → minute (every MinuteInterval) and minute → hour (every HourInterval).
type TrafficRollup struct {
    DB             *sqlx.DB
    MinuteInterval time.Duration // default 1 min
    HourInterval   time.Duration // default 1 h
}

func (r *TrafficRollup) Run(ctx context.Context) {
    mi := r.MinuteInterval
    if mi == 0 {
        mi = time.Minute
    }
    hi := r.HourInterval
    if hi == 0 {
        hi = time.Hour
    }
    minuteTicker := time.NewTicker(mi)
    hourTicker   := time.NewTicker(hi)
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

func (r *TrafficRollup) rollupRawToMinute(ctx context.Context) error {
    _, err := r.DB.ExecContext(ctx, `
        INSERT INTO xray_traffic_minute (server_id, tag, kind, ts, bytes_up, bytes_down)
        SELECT
            server_id,
            tag,
            kind,
            strftime('%Y-%m-%dT%H:%M:00Z', ts) AS ts,
            SUM(bytes_up),
            SUM(bytes_down)
        FROM xray_traffic_raw
        WHERE ts < strftime('%Y-%m-%dT%H:%M:00Z', 'now')
        GROUP BY server_id, tag, kind, strftime('%Y-%m-%dT%H:%M:00Z', ts)
        ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
            bytes_up   = excluded.bytes_up,
            bytes_down = excluded.bytes_down`)
    return err
}

func (r *TrafficRollup) rollupMinuteToHour(ctx context.Context) error {
    _, err := r.DB.ExecContext(ctx, `
        INSERT INTO xray_traffic_hour (server_id, tag, kind, ts, bytes_up, bytes_down)
        SELECT
            server_id,
            tag,
            kind,
            strftime('%Y-%m-%dT%H:00:00Z', ts) AS ts,
            SUM(bytes_up),
            SUM(bytes_down)
        FROM xray_traffic_minute
        WHERE ts < strftime('%Y-%m-%dT%H:00:00Z', 'now')
        GROUP BY server_id, tag, kind, strftime('%Y-%m-%dT%H:00:00Z', ts)
        ON CONFLICT (server_id, tag, kind, ts) DO UPDATE SET
            bytes_up   = excluded.bytes_up,
            bytes_down = excluded.bytes_down`)
    return err
}
```

Append retention entries in `internal/telemetrysvc/retention.go`, inside `Retention.Tick`'s range slice (after the existing three entries):

```go
{"traffic_raw_24h",   "xray_traffic_raw",    24 * time.Hour},
{"traffic_minute_7d", "xray_traffic_minute", 7 * 24 * time.Hour},
{"traffic_hour_90d",  "xray_traffic_hour",   90 * 24 * time.Hour},
```

Note: these three have fixed retention (no settings key), so the `Settings.Get` call will return an error and fall through to the default `dur = c.def`. The existing loop already handles this gracefully.

- [ ] **Step 4: Run test to verify PASS**

```bash
go test -run TestTrafficRollup ./internal/telemetrysvc/...
```

Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add internal/telemetrysvc/traffic_rollup.go \
        internal/telemetrysvc/traffic_rollup_test.go \
        internal/telemetrysvc/retention.go
git commit -m "feat(telemetrysvc): TrafficRollup (raw→minute→hour) + retention for traffic tables"
```

---

## Task 9: Start TrafficRollup goroutine in cmd/server/main.go

**Files:**
- Modify: `cmd/server/main.go`

- [ ] **Step 1: Verify compiles before change**

```bash
go build ./cmd/server/...
```

Expected: clean build.

- [ ] **Step 2: Implement**

In `cmd/server/main.go`, after the `tIngest := &telemetrysvc.Ingest{DB: d}` line (and before the `reg` line), add:

```go
trafficRollup := &telemetrysvc.TrafficRollup{DB: d}
go trafficRollup.Run(rootCtx)
```

This starts the rollup goroutine alongside the existing server loop. No test needed for this wiring change (integration verified by smoke test in Task 17).

- [ ] **Step 3: Verify build**

```bash
go build ./cmd/server/...
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add cmd/server/main.go
git commit -m "feat(server): start TrafficRollup goroutine at boot"
```

---

## Task 10: HTTP query endpoints — GET /traffic and GET /traffic/batch

**Files:**
- Modify: `internal/plugins/xray/routes.go`
- Create: `internal/plugins/xray/traffic_query.go`
- Create: `internal/plugins/xray/traffic_query_test.go`

- [ ] **Step 1: Write the failing test**

`internal/plugins/xray/traffic_query_test.go`:

```go
package xray

import (
    "context"
    "encoding/json"
    "net/http"
    "net/http/httptest"
    "path/filepath"
    "testing"
    "time"

    shepdb "github.com/hg-claw/Shepherd/internal/db"
    "github.com/hg-claw/Shepherd/internal/plugins"
)

func newTrafficDB(t *testing.T) (*sqlx.DB, int64) {
    t.Helper()
    dsn := "file:" + filepath.Join(t.TempDir(), "q.db") + "?_fk=1"
    d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
    t.Cleanup(func() { _ = d.Close() })
    _ = shepdb.Migrate(d, shepdb.DriverSQLite)
    _ = plugins.RunPluginMigrations(context.Background(), d, "xray", loadMigrations())
    res, _ := d.Exec("INSERT INTO servers(name) VALUES ('h')")
    sid, _ := res.LastInsertId()
    // Seed one raw row
    ts := time.Now().UTC().Add(-10 * time.Minute).Truncate(time.Second)
    d.MustExec(`INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
        VALUES (?, 'vless-reality-8443', 'inbound', ?, 1024, 2048)`, sid, ts)
    return d, sid
}

func TestTrafficQueryHandler_SingleTag(t *testing.T) {
    d, sid := newTrafficDB(t)
    h := trafficQueryHandler(d)

    from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
    to   := time.Now().UTC().Format(time.RFC3339)
    req := httptest.NewRequest("GET", "/traffic?server_id="+fmt.Sprint(sid)+
        "&tag=vless-reality-8443&kind=inbound&from="+from+"&to="+to, nil)
    w := httptest.NewRecorder()
    h(w, req)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
    }
    var resp trafficResponse
    if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
        t.Fatal(err)
    }
    if len(resp.Points) != 1 {
        t.Errorf("points = %d, want 1", len(resp.Points))
    }
    if resp.Points[0].BytesUp != 1024 {
        t.Errorf("BytesUp = %d, want 1024", resp.Points[0].BytesUp)
    }
}

func TestTrafficQueryHandler_AutoResolution(t *testing.T) {
    d, sid := newTrafficDB(t)
    h := trafficQueryHandler(d)

    // Time range > 7d → should auto-select "hour"
    from := time.Now().UTC().Add(-8 * 24 * time.Hour).Format(time.RFC3339)
    to   := time.Now().UTC().Format(time.RFC3339)
    req := httptest.NewRequest("GET", "/traffic?server_id="+fmt.Sprint(sid)+
        "&tag=vless-reality-8443&kind=inbound&from="+from+"&to="+to, nil)
    w := httptest.NewRecorder()
    h(w, req)

    var resp trafficResponse
    _ = json.NewDecoder(w.Body).Decode(&resp)
    if resp.Resolution != "hour" {
        t.Errorf("resolution = %q, want 'hour'", resp.Resolution)
    }
}

func TestTrafficBatchQueryHandler(t *testing.T) {
    d, sid := newTrafficDB(t)
    h := trafficBatchQueryHandler(d)

    from := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
    to   := time.Now().UTC().Format(time.RFC3339)
    req := httptest.NewRequest("GET", "/traffic/batch?server_id="+fmt.Sprint(sid)+
        "&tags=vless-reality-8443,vmess-ws-443&kind=inbound&from="+from+"&to="+to, nil)
    w := httptest.NewRecorder()
    h(w, req)

    if w.Code != http.StatusOK {
        t.Fatalf("status = %d, want 200; body: %s", w.Code, w.Body.String())
    }
    var resp trafficBatchResponse
    if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
        t.Fatal(err)
    }
    if len(resp.Series) == 0 {
        t.Error("expected at least one series")
    }
}
```

(Add `"fmt"` and `"github.com/jmoiron/sqlx"` imports.)

- [ ] **Step 2: Run test to verify it fails**

```bash
go test -run TestTrafficQueryHandler ./internal/plugins/xray/...
```

Expected: FAIL — `trafficQueryHandler` undefined.

- [ ] **Step 3: Implement**

`internal/plugins/xray/traffic_query.go`:

```go
package xray

import (
    "encoding/json"
    "net/http"
    "strconv"
    "strings"
    "time"

    "github.com/jmoiron/sqlx"
)

type trafficPoint struct {
    TS        time.Time `json:"ts"`
    BytesUp   int64     `json:"bytes_up"`
    BytesDown int64     `json:"bytes_down"`
}

type trafficResponse struct {
    ServerID   int64          `json:"server_id"`
    Tag        string         `json:"tag"`
    Kind       string         `json:"kind"`
    Resolution string         `json:"resolution"`
    Points     []trafficPoint `json:"points"`
}

type trafficSeries struct {
    Tag    string         `json:"tag"`
    Kind   string         `json:"kind"`
    Points []trafficPoint `json:"points"`
}

type trafficBatchResponse struct {
    Resolution string          `json:"resolution"`
    Series     []trafficSeries `json:"series"`
}

// chooseResolution picks the table name based on the time span when resolution
// is not explicitly specified.
func chooseResolution(from, to time.Time, explicit string) (string, error) {
    if explicit != "" {
        switch explicit {
        case "raw", "minute", "hour":
            return explicit, nil
        }
        return "", errBadRequest("resolution must be raw, minute, or hour")
    }
    span := to.Sub(from)
    switch {
    case span <= 2*time.Hour:
        return "raw", nil
    case span <= 7*24*time.Hour:
        return "minute", nil
    default:
        return "hour", nil
    }
}

func tableForResolution(res string) string {
    switch res {
    case "minute":
        return "xray_traffic_minute"
    case "hour":
        return "xray_traffic_hour"
    default:
        return "xray_traffic_raw"
    }
}

type httpErr struct{ code int; msg string }

func (e httpErr) Error() string { return e.msg }

func errBadRequest(msg string) error { return httpErr{code: 400, msg: msg} }

func parseTrafficParams(r *http.Request) (serverID int64, tag, kind string, from, to time.Time, resolution string, err error) {
    q := r.URL.Query()
    sidStr := q.Get("server_id")
    if sidStr == "" {
        err = errBadRequest("server_id required")
        return
    }
    sid64, e := strconv.ParseInt(sidStr, 10, 64)
    if e != nil {
        err = errBadRequest("invalid server_id")
        return
    }
    serverID = sid64
    tag = q.Get("tag")
    kind = q.Get("kind")
    fromStr := q.Get("from")
    toStr   := q.Get("to")
    if fromStr == "" || toStr == "" {
        err = errBadRequest("from and to required")
        return
    }
    from, e = time.Parse(time.RFC3339, fromStr)
    if e != nil {
        err = errBadRequest("invalid from")
        return
    }
    to, e = time.Parse(time.RFC3339, toStr)
    if e != nil {
        err = errBadRequest("invalid to")
        return
    }
    resolution = q.Get("resolution")
    return
}

func queryPoints(db *sqlx.DB, r *http.Request, table, tag, kind string, serverID int64, from, to time.Time) ([]trafficPoint, error) {
    query := `SELECT ts, bytes_up, bytes_down FROM ` + table +
        ` WHERE server_id = $1 AND tag = $2`
    args := []any{serverID, tag}
    if kind != "" {
        query += ` AND kind = $3 AND ts BETWEEN $4 AND $5 ORDER BY ts ASC`
        args = append(args, kind, from.UTC(), to.UTC())
    } else {
        query += ` AND ts BETWEEN $3 AND $4 ORDER BY ts ASC`
        args = append(args, from.UTC(), to.UTC())
    }
    rows, err := db.QueryxContext(r.Context(), query, args...)
    if err != nil {
        return nil, err
    }
    defer func() { _ = rows.Close() }()
    var pts []trafficPoint
    for rows.Next() {
        var p trafficPoint
        if err := rows.Scan(&p.TS, &p.BytesUp, &p.BytesDown); err != nil {
            return nil, err
        }
        pts = append(pts, p)
    }
    return pts, rows.Err()
}

func trafficQueryHandler(db *sqlx.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        serverID, tag, kind, from, to, resParam, err := parseTrafficParams(r)
        if err != nil {
            if he, ok := err.(httpErr); ok {
                http.Error(w, he.msg, he.code)
            } else {
                http.Error(w, err.Error(), 500)
            }
            return
        }
        if tag == "" {
            http.Error(w, "tag required", 400)
            return
        }
        res, err := chooseResolution(from, to, resParam)
        if err != nil {
            http.Error(w, err.Error(), 400)
            return
        }
        if res == "raw" && to.Sub(from) > 24*time.Hour {
            http.Error(w, "raw resolution only available for spans <= 24h", 400)
            return
        }
        table := tableForResolution(res)
        pts, err := queryPoints(db, r, table, tag, kind, serverID, from, to)
        if err != nil {
            http.Error(w, err.Error(), 500)
            return
        }
        if pts == nil {
            pts = []trafficPoint{}
        }
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(trafficResponse{
            ServerID:   serverID,
            Tag:        tag,
            Kind:       kind,
            Resolution: res,
            Points:     pts,
        })
    }
}

func trafficBatchQueryHandler(db *sqlx.DB) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        serverID, _, kind, from, to, resParam, err := parseTrafficParams(r)
        if err != nil {
            if he, ok := err.(httpErr); ok {
                http.Error(w, he.msg, he.code)
            } else {
                http.Error(w, err.Error(), 500)
            }
            return
        }
        tagsRaw := r.URL.Query().Get("tags")
        if tagsRaw == "" {
            http.Error(w, "tags required", 400)
            return
        }
        tags := strings.Split(tagsRaw, ",")
        res, err := chooseResolution(from, to, resParam)
        if err != nil {
            http.Error(w, err.Error(), 400)
            return
        }
        table := tableForResolution(res)
        series := make([]trafficSeries, 0, len(tags))
        for _, tag := range tags {
            tag = strings.TrimSpace(tag)
            if tag == "" {
                continue
            }
            pts, err := queryPoints(db, r, table, tag, kind, serverID, from, to)
            if err != nil {
                http.Error(w, err.Error(), 500)
                return
            }
            if pts == nil {
                pts = []trafficPoint{}
            }
            series = append(series, trafficSeries{Tag: tag, Kind: kind, Points: pts})
        }
        w.Header().Set("Content-Type", "application/json")
        _ = json.NewEncoder(w).Encode(trafficBatchResponse{Resolution: res, Series: series})
    }
}
```

Register in `internal/plugins/xray/routes.go`, inside `RegisterRoutes`, before the closing brace:

```go
mux.HandleFunc("GET /traffic",       trafficQueryHandler(deps.DB))
mux.HandleFunc("GET /traffic/batch", trafficBatchQueryHandler(deps.DB))
```

- [ ] **Step 4: Run test to verify PASS**

```bash
go test -run TestTrafficQuery -run TestTrafficBatch ./internal/plugins/xray/...
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/plugins/xray/traffic_query.go \
        internal/plugins/xray/traffic_query_test.go \
        internal/plugins/xray/routes.go
git commit -m "feat(xray/routes): GET /traffic and GET /traffic/batch query endpoints"
```

---

## Task 11: Install recharts

**Files:**
- Modify: `web/package.json` (via npm)
- Modify: `web/package-lock.json`

- [ ] **Step 1: Install**

```bash
cd /path/to/Shepherd/web && npm install recharts
```

- [ ] **Step 2: Verify import resolves**

```bash
node -e "require('recharts')" && echo "ok"
```

Or simply proceed to Task 12 where recharts is first imported; `vite build` will catch a missing resolution.

- [ ] **Step 3: Commit**

```bash
git add web/package.json web/package-lock.json
git commit -m "chore(web): add recharts dependency for traffic area chart"
```

---

## Task 12: Web API client types and fetchers

**Files:**
- Modify: `web/src/api/plugins.ts`

- [ ] **Step 1: Write the failing test**

The TS types are validated at compile time. Add a compile-only check in a new test-only file, or simply verify `tsc --noEmit` after the implementation. The test here is the TypeScript compiler:

```bash
cd web && npx tsc --noEmit
```

Expected BEFORE implementation: passes (types not yet added, not yet imported).

- [ ] **Step 2: Implement**

Append to `web/src/api/plugins.ts`:

```typescript
// ── xray traffic monitoring ──────────────────────────────────────────────────

export interface XrayTrafficPoint {
  ts: string       // ISO 8601 UTC
  bytes_up: number
  bytes_down: number
}

export interface XrayTrafficSeries {
  tag: string
  kind: string
  points: XrayTrafficPoint[]
}

export interface XrayTrafficResponse {
  server_id: number
  tag: string
  kind: string
  resolution: 'raw' | 'minute' | 'hour'
  points: XrayTrafficPoint[]
}

export interface XrayTrafficBatchResponse {
  resolution: 'raw' | 'minute' | 'hour'
  series: XrayTrafficSeries[]
}

export const fetchXrayTraffic = (params: {
  server_id: number
  tag: string
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<XrayTrafficResponse> => {
  const q = new URLSearchParams({ server_id: String(params.server_id), tag: params.tag, from: params.from, to: params.to })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<XrayTrafficResponse>(`/api/admin/plugins/xray/traffic?${q}`)
}

export const fetchXrayTrafficBatch = (params: {
  server_id: number
  tags: string[]
  kind?: string
  from: string
  to: string
  resolution?: 'raw' | 'minute' | 'hour'
}): Promise<XrayTrafficBatchResponse> => {
  const q = new URLSearchParams({
    server_id: String(params.server_id),
    tags: params.tags.join(','),
    from: params.from,
    to: params.to,
  })
  if (params.kind)       q.set('kind', params.kind)
  if (params.resolution) q.set('resolution', params.resolution)
  return api.get<XrayTrafficBatchResponse>(`/api/admin/plugins/xray/traffic/batch?${q}`)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd web && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/api/plugins.ts
git commit -m "feat(web/api): XrayTrafficPoint types + fetchXrayTraffic / fetchXrayTrafficBatch"
```

---

## Task 13: TrafficDrawer component (recharts AreaChart drill-down)

**Files:**
- Create: `web/src/pages/admin/plugins/xray/TrafficDrawer.tsx`

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/admin/plugins/xray/TrafficDrawer.test.tsx`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TrafficDrawer from './TrafficDrawer'

// Mock the API module
vi.mock('@/api/plugins', () => ({
  fetchXrayTraffic: vi.fn().mockResolvedValue({
    server_id: 1,
    tag: 'vless-reality-8443',
    kind: 'inbound',
    resolution: 'raw',
    points: [
      { ts: '2026-05-19T10:00:00Z', bytes_up: 1024, bytes_down: 2048 },
    ],
  }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('TrafficDrawer', () => {
  it('renders tag title and time range buttons', () => {
    render(
      <TrafficDrawer
        open={true}
        onOpenChange={() => {}}
        serverID={1}
        tag="vless-reality-8443"
        kind="inbound"
      />,
      { wrapper }
    )
    expect(screen.getByText(/vless-reality-8443/)).toBeTruthy()
    expect(screen.getByText('1h')).toBeTruthy()
    expect(screen.getByText('24h')).toBeTruthy()
    expect(screen.getByText('7d')).toBeTruthy()
    expect(screen.getByText('30d')).toBeTruthy()
  })

  it('sends resolution=minute when 7d is selected', async () => {
    const { fetchXrayTraffic } = await import('@/api/plugins')
    render(
      <TrafficDrawer
        open={true}
        onOpenChange={() => {}}
        serverID={1}
        tag="vless-reality-8443"
        kind="inbound"
      />,
      { wrapper }
    )
    fireEvent.click(screen.getByText('7d'))
    // After clicking 7d, useQuery re-fetches with resolution=minute
    expect(fetchXrayTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'minute' })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- TrafficDrawer
```

Expected: FAIL — `TrafficDrawer` module not found.

- [ ] **Step 3: Implement**

`web/src/pages/admin/plugins/xray/TrafficDrawer.tsx`:

```tsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts'
import {
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { fetchXrayTraffic, type XrayTrafficPoint } from '@/api/plugins'

type TimeRange = '1h' | '24h' | '7d' | '30d'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverID: number
  tag: string
  kind: string
}

function rangeToParams(range: TimeRange): {
  from: string
  to: string
  resolution: 'raw' | 'minute' | 'hour'
} {
  const now = new Date()
  const to = now.toISOString()
  switch (range) {
    case '1h':
      return { from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), to, resolution: 'raw' }
    case '24h':
      return { from: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(), to, resolution: 'raw' }
    case '7d':
      return { from: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(), to, resolution: 'minute' }
    case '30d':
      return { from: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(), to, resolution: 'hour' }
  }
}

function formatBytes(v: number): string {
  if (v >= 1_073_741_824) return `${(v / 1_073_741_824).toFixed(1)} GB`
  if (v >= 1_048_576)     return `${(v / 1_048_576).toFixed(1)} MB`
  if (v >= 1024)          return `${(v / 1024).toFixed(1)} KB`
  return `${v} B`
}

function formatTime(ts: string, range: TimeRange): string {
  const d = new Date(ts)
  if (range === '30d' || range === '7d') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export default function TrafficDrawer({ open, onOpenChange, serverID, tag, kind }: Props) {
  const [range, setRange] = useState<TimeRange>('1h')
  const params = rangeToParams(range)

  const q = useQuery({
    queryKey: ['xray-traffic', serverID, tag, kind, range],
    queryFn: () => fetchXrayTraffic({ server_id: serverID, tag, kind, ...params }),
    enabled: open,
    refetchInterval: 30_000,
  })

  const points: XrayTrafficPoint[] = q.data?.points ?? []

  const totalUp   = points.reduce((s, p) => s + p.bytes_up,   0)
  const totalDown = points.reduce((s, p) => s + p.bytes_down, 0)

  const chartData = points.map((p) => ({
    ts:         p.ts,
    bytes_up:   p.bytes_up,
    bytes_down: p.bytes_down,
  }))

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[520px] max-w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="font-mono text-sm">{tag} 流量</SheetTitle>
        </SheetHeader>

        {/* Time range selector */}
        <div className="flex gap-2 mt-4">
          {(['1h', '24h', '7d', '30d'] as TimeRange[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? 'default' : 'outline'}
              className="h-7 px-3 text-[12px]"
              onClick={() => setRange(r)}
            >
              {r}
            </Button>
          ))}
        </div>

        {/* Cumulative stats */}
        <div className="flex gap-6 mt-4 text-[13px]">
          <div>
            <div className="text-muted-foreground text-[11px] uppercase tracking-wide">上行</div>
            <div className="font-mono">{formatBytes(totalUp)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-[11px] uppercase tracking-wide">下行</div>
            <div className="font-mono">{formatBytes(totalDown)}</div>
          </div>
        </div>

        {/* Area chart */}
        <div className="mt-6">
          {q.isLoading && (
            <div className="h-[200px] flex items-center justify-center text-muted-foreground text-[13px]">
              加载中…
            </div>
          )}
          {!q.isLoading && chartData.length === 0 && (
            <div className="h-[200px] flex items-center justify-center text-muted-foreground text-[13px]">
              暂无数据
            </div>
          )}
          {!q.isLoading && chartData.length > 0 && (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                <XAxis
                  dataKey="ts"
                  tickFormatter={(v) => formatTime(v as string, range)}
                  tick={{ fontSize: 11 }}
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={(v) => formatBytes(v as number)}
                  tick={{ fontSize: 11 }}
                  width={60}
                />
                <Tooltip
                  formatter={(v: number) => formatBytes(v)}
                  labelFormatter={(l: string) => formatTime(l, range)}
                />
                <Area
                  type="monotone"
                  dataKey="bytes_up"
                  name="上行"
                  stackId="1"
                  fill="#3b82f6"
                  stroke="#3b82f6"
                  fillOpacity={0.3}
                />
                <Area
                  type="monotone"
                  dataKey="bytes_down"
                  name="下行"
                  stackId="1"
                  fill="#22c55e"
                  stroke="#22c55e"
                  fillOpacity={0.3}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 4: Run test to verify PASS**

```bash
cd web && npm test -- TrafficDrawer
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/admin/plugins/xray/TrafficDrawer.tsx \
        web/src/pages/admin/plugins/xray/TrafficDrawer.test.tsx
git commit -m "feat(web/xray): TrafficDrawer with recharts AreaChart + time range selector"
```

---

## Task 14: Integrate sparkline + drawer trigger into HostsTab

**Files:**
- Modify: `web/src/pages/admin/plugins/xray/HostsTab.tsx`

Note: Phase 3c-1 may have renamed `HostsTab` to `InboundsTab`. Apply these changes to whichever file is the active inbound list at the time 3c-1 lands. The instructions below use `HostsTab.tsx` matching the current codebase; rename the reference file as needed.

- [ ] **Step 1: Write the failing test**

Add to (or create) `web/src/pages/admin/plugins/xray/HostsTab.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import HostsTab from './HostsTab'

vi.mock('@/api/plugins', () => ({
  listPluginHosts: vi.fn().mockResolvedValue([
    { id: 1, server_id: 1, status: 'running', deployed_version: '1.8.11', config: {}, updated_at: '' },
  ]),
  fetchXrayTopology: vi.fn().mockResolvedValue(new Map([[1, { role: 'landing', upstream_server_id: null, upstream_name: null }]])),
  fetchXrayTrafficBatch: vi.fn().mockResolvedValue({ resolution: 'raw', series: [] }),
  removePluginHost: vi.fn(),
}))
vi.mock('@/api/servers', () => ({
  useServers: vi.fn(() => ({ data: [{ id: 1, name: 'server-1', ssh_host: { Valid: true, String: '1.2.3.4' } }] })),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('HostsTab', () => {
  it('renders Traffic column header', () => {
    render(<HostsTab />, { wrapper })
    expect(screen.getByText(/traffic/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd web && npm test -- HostsTab
```

Expected: FAIL — Traffic column not rendered.

- [ ] **Step 3: Implement**

In `web/src/pages/admin/plugins/xray/HostsTab.tsx`:

1. Add imports at the top:

```tsx
import { fetchXrayTrafficBatch, type XrayTrafficSeries } from '@/api/plugins'
import { Sparkline } from '@/components/Sparkline'
import TrafficDrawer from './TrafficDrawer'
```

2. Add a query for traffic batch data (after `topoQ`):

```tsx
const allServerIDs = (serversQ.data ?? []).map((s) => s.id)
// Collect all deployed tags for batch fetch. This runs once per render; fine for < 50 tags.
const allDeployedTags = (hostsQ.data ?? []).flatMap((h) => {
  // Phase 3c-1: iterate inbounds from h if available; for now, derive tag from config.
  const cfg = h.config as any
  const inbs: any[] = Array.isArray(cfg?.inbounds) ? cfg.inbounds : []
  return inbs.map((ib: any) => ib?.tag as string).filter(Boolean)
})

const firstServerID = (hostsQ.data ?? [])[0]?.server_id ?? 0
const trafficQ = useQuery({
  queryKey: ['xray-traffic-batch', firstServerID, allDeployedTags.join(',')],
  queryFn: () => {
    if (allDeployedTags.length === 0 || firstServerID === 0) return Promise.resolve({ resolution: 'raw' as const, series: [] })
    const now = new Date()
    return fetchXrayTrafficBatch({
      server_id: firstServerID,
      tags: allDeployedTags,
      kind: 'inbound',
      from: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
      to: now.toISOString(),
      resolution: 'raw',
    })
  },
  enabled: allDeployedTags.length > 0,
  refetchInterval: 30_000,
})

// Build a map of tag → sparkline values (bytes_up + bytes_down per point).
const sparklineByTag = new Map<string, number[]>()
for (const series of trafficQ.data?.series ?? []) {
  sparklineByTag.set(series.tag, series.points.map((p) => p.bytes_up + p.bytes_down))
}
```

3. Add drawer state:

```tsx
const [trafficDrawer, setTrafficDrawer] = useState<{ serverID: number; tag: string; kind: string } | null>(null)
```

4. Add a **Traffic** `<th>` column header after the Version column:

```tsx
<th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Traffic</th>
```

5. In each deployed row `<td>`, after the Version `<td>`, add:

```tsx
<td className="px-3 py-2">
  {/* Phase 3c-1 tag from inbound; fall back to server-level placeholder */}
  {(() => {
    const cfg = h?.config as any
    const inbs: any[] = Array.isArray(cfg?.inbounds) ? cfg.inbounds : []
    const tag = inbs[0]?.tag as string | undefined
    if (!tag) return <span className="text-muted-foreground text-[12px]">—</span>
    const vals = sparklineByTag.get(tag) ?? []
    return (
      <button
        className="flex items-center gap-1 hover:opacity-70 transition-opacity"
        title="查看流量详情"
        onClick={() => setTrafficDrawer({ serverID: s.id, tag, kind: 'inbound' })}
      >
        <Sparkline values={vals} width={80} height={24} className="text-primary" />
      </button>
    )
  })()}
</td>
```

6. Add a **Not-deployed** row `<td>` placeholder (empty cell):

```tsx
<td className="px-3 py-2" />
```

7. Increment `colSpan` in the empty-state row from 7 to 8.

8. At the bottom of the return, before the closing `</div>`, add:

```tsx
{trafficDrawer && (
  <TrafficDrawer
    open={true}
    onOpenChange={(open) => { if (!open) setTrafficDrawer(null) }}
    serverID={trafficDrawer.serverID}
    tag={trafficDrawer.tag}
    kind={trafficDrawer.kind}
  />
)}
```

- [ ] **Step 4: Run test to verify PASS**

```bash
cd web && npm test -- HostsTab
```

Expected: PASS

- [ ] **Step 5: Build check**

```bash
cd web && npm run build
```

Expected: clean build (tsc + vite).

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/admin/plugins/xray/HostsTab.tsx \
        web/src/pages/admin/plugins/xray/HostsTab.test.tsx
git commit -m "feat(web/xray): add Traffic sparkline column + drawer trigger to HostsTab"
```

---

## Task 15: Full Go build + test gate

- [ ] **Step 1: Build all**

```bash
go build ./...
```

Expected: no errors.

- [ ] **Step 2: Run all Go tests**

```bash
go test ./...
```

Expected: all PASS.

- [ ] **Step 3: Fix any failures before proceeding**

If `go test` fails on any package:
- Read the failure message precisely.
- Fix only the exact failing assertion — do not refactor unrelated code.
- Re-run until green.

---

## Task 16: Full frontend build + test gate

- [ ] **Step 1: TypeScript check**

```bash
cd web && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 2: Run all frontend tests**

```bash
cd web && npm test
```

Expected: all PASS.

- [ ] **Step 3: Production build**

```bash
cd web && npm run build
```

Expected: exits 0, `dist/` produced.

---

## Task 17: E2E Smoke Checklist (manual)

- [ ] **1. Verify socket exists after deploy**

SSH into the xray host. After Phase 3c-2 renders and deploys the new config, confirm:

```bash
ls -la /var/run/shepherd-xray-api.sock
```

Expected: socket file present, owned by the xray process user.

- [ ] **2. Manual CLI stats query**

```bash
xray api statsquery --server=unix:/var/run/shepherd-xray-api.sock --reset=false --pattern=
```

Expected: JSON array with entries like `{"name":"inbound>>>landing-aabbccdd>>>traffic>>>uplink","value":0}`.

- [ ] **3. Agent logs — first tick**

In the agent logs, after connection:

```
xraysampler: query failed: ...
```

should NOT appear on a healthy xray host. The agent should silently produce no log on first tick (it stores snapshot, does not send).

- [ ] **4. 30s wait — sparkline appears**

Open the Shepherd UI → xray plugin → HostsTab. Wait 30–40 s. Confirm the Traffic column shows a flat sparkline (even zero bytes is a valid polyline of length ≥ 2).

- [ ] **5. Send 1 MB of traffic through an inbound**

Use any VLESS client connected through the xray inbound. Transfer at least 1 MB.

- [ ] **6. 30s wait — sparkline updates**

After the next 30s tick, the sparkline peak should be visible (bytes_up + bytes_down > 0).

- [ ] **7. Click sparkline — drawer opens**

Click the sparkline row in HostsTab. Confirm `TrafficDrawer` slides in from the right with the tag name in the title and 4 time-range buttons (1h / 24h / 7d / 30d).

- [ ] **8. Wait 60s — minute table populated**

On the server host (or via a DB client):

```sql
SELECT COUNT(*) FROM xray_traffic_minute WHERE tag = 'landing-aabbccdd';
```

Expected: at least 1 row after the rollup ticker fires (~60 s after boot).

- [ ] **9. xray restart → no negative spike**

```bash
systemctl restart shepherd-xray
```

Wait 60 s. Observe the sparkline: it should show a 0-byte point at the restart moment, not a negative dip or sudden massive spike.

- [ ] **10. Verify retention does not immediately delete**

The `xray_traffic_raw` retention is 24h. After the smoke test, confirm rows exist:

```sql
SELECT COUNT(*) FROM xray_traffic_raw WHERE ts > datetime('now', '-1 hour');
```

Expected: count > 0.

---

## Self-Review Notes

### Spec Coverage

| Spec section | Covered by task |
|---|---|
| §1.1 deliverables (config inject) | Task 2 |
| §1.1 deliverables (agent sampler) | Tasks 4, 5, 6 |
| §1.1 deliverables (WS envelope) | Task 3 |
| §1.1 deliverables (server ingest) | Task 7 |
| §1.1 deliverables (three-layer tables) | Task 1 |
| §1.1 deliverables (rollup tasks) | Task 8, 9 |
| §1.1 deliverables (retention) | Task 8 |
| §1.1 deliverables (HTTP API) | Task 10 |
| §1.1 deliverables (UI sparkline) | Task 14 |
| §1.1 deliverables (UI drill-down) | Task 13 |
| §2.1 DDL (three tables + indexes) | Task 1 |
| §3.1–3.4 api inbound injection | Task 2 |
| §4.1–4.2 sampler package + loop | Task 5 |
| §4.3 CLI choice + parsing | Task 4 |
| §4.4 error handling (socket missing, restart) | Task 4 (parse), Task 5 (sampler logic) |
| §4.5 startup timing (goroutine in dialAndRun) | Task 6 |
| §5.1–5.2 XrayTrafficBatch wire format | Task 3 |
| §5.3 WriteTrafficBatch ingest | Task 7 |
| §5.4 no ACK | Implicit (no ack code written) |
| §6.1–6.2 rollup SQL + tickers | Task 8 |
| §6.3 retention | Task 8 |
| §6.4 concurrency safety | Handled by ON CONFLICT DO UPDATE (idempotent) |
| §7.1–7.3 single tag query + auto resolution | Task 10 |
| §7.4 batch endpoint | Task 10 |
| §8.1 sparkline in HostsTab | Task 14 |
| §8.2 drill-down drawer (Sheet + recharts) | Task 13 |
| §8.3 overview tile | Not implemented — spec marks as v1 optional |
| §8.4 recharts install | Task 11 |
| §9.1–9.3 lifecycle (cascade delete, restart zeroing) | Handled by DDL CASCADE (Task 1) and max(0, delta) (Task 5) |
| §10 migration 0004 | Task 1 |
| §11.1–11.4 test matrix (Go) | Tasks 4, 5, 7, 8 |
| §11.5 UI unit tests | Tasks 13, 14 |
| §11.6 smoke | Task 17 |

### Placeholder Scan

None. All code blocks in this plan are complete and copy-paste ready.

### Type Consistency

| Symbol | Defined in | Used in |
|---|---|---|
| `agentapi.TypeXrayTraffic` | Task 3 (`types.go`) | Tasks 5, 7 |
| `agentapi.XrayTrafficSample` | Task 3 (`types.go`) | Tasks 5, 7 |
| `agentapi.XrayTrafficBatch` | Task 3 (`types.go`) | Tasks 5, 7 |
| `xraysampler.Sampler` | Task 5 (`sampler.go`) | Task 6 (`client.go`, `main.go`) |
| `xraysampler.statKey` | Task 4 (`parse.go`) | Task 5 (`sampler.go`) — same package |
| `telemetrysvc.TrafficRollup` | Task 8 | Task 9 (`main.go`) |
| `Ingest.WriteTrafficBatch` | Task 7 (`traffic_ingest.go`) | Task 7 test |
| `trafficQueryHandler` | Task 10 (`traffic_query.go`) | Task 10 (`routes.go`) |
| `trafficBatchQueryHandler` | Task 10 (`traffic_query.go`) | Task 10 (`routes.go`) |
| `XrayTrafficPoint` (TS) | Task 12 (`plugins.ts`) | Tasks 13, 14 |
| `XrayTrafficBatchResponse` (TS) | Task 12 (`plugins.ts`) | Task 14 |
| `fetchXrayTraffic` (TS) | Task 12 (`plugins.ts`) | Task 13 |
| `fetchXrayTrafficBatch` (TS) | Task 12 (`plugins.ts`) | Task 14 |
| `TrafficDrawer` (React) | Task 13 | Task 14 |
| `injectStatsAndAPI` (Go) | Task 2 (`config.go`) | Task 2 (called from `RenderServerConfig`) |
| `apiInboundTag`, `apiSocketPath` | Task 2 (`config.go`) | Task 5 (socket path constant via agent config) |
| `xrayplugin.Migrations()` | Task 7 (`migrations.go`) | Tasks 7, 8 test helpers |
