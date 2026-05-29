package agentapi

import "time"

// Type constants — keep in lockstep with spec §5.
const (
	TypeConfigUpdate   = "config.update"
	TypePing           = "ping"
	TypePong           = "pong"
	TypeHeartbeat      = "heartbeat"
	TypeTelemetry      = "telemetry"
	TypeXrayTraffic    = "xray.traffic"
	TypeSingboxTraffic = "singbox.traffic"
	// TypeNetqualityConfig: server → agent. Sent on each WS connect (and
	// whenever the per-server config changes) so the agent knows what to
	// ping at what cadence. Empty Targets means "do not sample" — the
	// sampler short-circuits without exec'ing ping. This is the per-host
	// opt-in mechanism; flipping netquality_hosts.enabled=false on the
	// server reduces to pushing an empty Targets list here.
	TypeNetqualityConfig = "netquality.config"
	// TypeNetqualityBatch: agent → server. One batch per sample interval
	// carrying every target's last probe result.
	TypeNetqualityBatch = "netquality.batch"
	// TypeHostInventory: agent → server. Static hardware inventory, sent once
	// on each WS (re)connect.
	TypeHostInventory = "host.inventory"
)

// ConfigUpdate is a full snapshot pushed by the server to an agent. Each field
// is optional via omitempty so unknown senders don't poison fields they don't
// know about. The agent applies a non-zero/non-nil field; zero/nil is "no
// change". TelemetryIntervalSeconds=0 therefore means "no change" in this
// model — the server never sends 0 except in the empty-snapshot case, which
// the agent treats as a no-op.
type ConfigUpdate struct {
	TelemetryIntervalSeconds int      `json:"telemetry_interval_seconds,omitempty"`
	FileSandboxEnabled       *bool    `json:"file_sandbox_enabled,omitempty"`
	FileSandboxPaths         []string `json:"file_sandbox_paths,omitempty"`
	// LogVerbose toggles agent debug-level logging at runtime. Pointer so
	// "field omitted" stays distinguishable from "set to false". Wired
	// through vlog so flipping the admin-settings switch fans out to all
	// online agents without restart.
	LogVerbose *bool `json:"log_verbose,omitempty"`
}

type Heartbeat struct {
	TS           time.Time `json:"ts"`
	AgentVersion string    `json:"agent_version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	Kernel       string    `json:"kernel"`
	// IPCandidates is sent on the FIRST heartbeat after each WS connect.
	// Server upserts into server_ip_candidates and auto-picks ssh_host when
	// it's still empty. Periodic heartbeats omit the field to avoid DB churn.
	IPCandidates []IPCandidate `json:"ip_candidates,omitempty"`
}

type Disk struct {
	Mount string `json:"mount"`
	Used  int64  `json:"used"`
	Total int64  `json:"total"`
}

type GPU struct {
	Name    string `json:"name"`
	VRAMMiB int64  `json:"vram_mib"` // 0 when unknown (lspci fallback)
}

type HostInventory struct {
	CPUPhysical int    `json:"cpu_physical"`
	CPULogical  int    `json:"cpu_logical"`
	CPUModel    string `json:"cpu_model"`
	MemTotal    int64  `json:"mem_total"`
	DiskTotal   int64  `json:"disk_total"`
	GPUs        []GPU  `json:"gpus"`
}

type Telemetry struct {
	TS       time.Time `json:"ts"`
	CPUPct   float64   `json:"cpu_pct"`
	MemUsed  int64     `json:"mem_used"`
	MemTotal int64     `json:"mem_total"`
	Load1    float64   `json:"load_1"`
	Load5    float64   `json:"load_5"`
	Load15   float64   `json:"load_15"`
	NetRxBps int64     `json:"net_rx_bps"`
	NetTxBps int64     `json:"net_tx_bps"`
	TCPConn  int       `json:"tcp_conn"`
	Disks    []Disk    `json:"disks"`
}

// IPCandidate is a single network address the agent detected at boot.
type IPCandidate struct {
	Addr   string `json:"addr"`
	Kind   string `json:"kind"`   // public | private | cgnat | vpn
	Source string `json:"source"` // interface name or "ipify"
}

type EnrollRequest struct {
	EnrollmentToken string        `json:"enrollment_token"`
	Fingerprint     string        `json:"fingerprint"`
	OS              string        `json:"os"`
	Arch            string        `json:"arch"`
	Kernel          string        `json:"kernel"`
	AgentVersion    string        `json:"agent_version"`
	IPCandidates    []IPCandidate `json:"ip_candidates,omitempty"`
}

type EnrollResponse struct {
	MachineToken string `json:"machine_token"`
	ServerID     int64  `json:"server_id"`
}

type AutoRegisterRequest struct {
	AutoRecoverKey string        `json:"auto_recover_key"`
	Fingerprint    string        `json:"fingerprint"`
	Hostname       string        `json:"hostname"`
	OS             string        `json:"os"`
	Arch           string        `json:"arch"`
	Kernel         string        `json:"kernel"`
	AgentVersion   string        `json:"agent_version"`
	IPCandidates   []IPCandidate `json:"ip_candidates,omitempty"`
}

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

// SingboxTrafficSample is a per-inbound-tag traffic delta for one 30s window.
// Kind mirrors the inbound role: "landing" or "relay".
type SingboxTrafficSample struct {
	Tag       string    `json:"tag"`  // e.g. "landing-aabb1122"
	Kind      string    `json:"kind"` // "landing" | "relay"
	TS        time.Time `json:"ts"`   // sample timestamp, UTC
	BytesUp   int64     `json:"bytes_up"`
	BytesDown int64     `json:"bytes_down"`
}

// SingboxTrafficBatch is the payload of a TypeSingboxTraffic envelope.
type SingboxTrafficBatch struct {
	Samples []SingboxTrafficSample `json:"samples"`
}

// ── netquality plugin ──────────────────────────────────────────────────────

// NetqualityTarget is one probe destination as the agent sees it. ID is
// the row PK from netquality_targets so the ingest write can join back
// to the catalog without a host-name round-trip.
type NetqualityTarget struct {
	ID   int64  `json:"id"`
	Host string `json:"host"` // IP or hostname passed to ping(1)
}

// NetqualityConfig is the payload of TypeNetqualityConfig. The server
// sends this once per WS connect plus on every per-host config change.
// IntervalSeconds=0 in a sent config is treated as "default" (300s) by
// the sampler — explicit zero never means "sample as fast as possible".
type NetqualityConfig struct {
	Targets         []NetqualityTarget `json:"targets"`
	IntervalSeconds int                `json:"interval_seconds"`
}

// NetqualitySample is the result of one ping burst against one target.
// Status='ok' on at least one reply, 'lost' on 100% loss (still emits a
// row so the UI can render a gap accurately), 'error' on ping(1)
// invocation failure (no route, name resolution, sandboxed exec).
// RTT pointers are nil when status != 'ok' — they'd be misleading zeros
// otherwise.
type NetqualitySample struct {
	TargetID int64     `json:"target_id"`
	TS       time.Time `json:"ts"`
	Status   string    `json:"status"` // ok | lost | error
	RTTAvgMs *float64  `json:"rtt_avg_ms,omitempty"`
	RTTMinMs *float64  `json:"rtt_min_ms,omitempty"`
	RTTMaxMs *float64  `json:"rtt_max_ms,omitempty"`
	JitterMs *float64  `json:"jitter_ms,omitempty"` // mdev from ping output
	LossPct  float64   `json:"loss_pct"`            // 0..100
}

// NetqualityBatch is the payload of a TypeNetqualityBatch envelope.
type NetqualityBatch struct {
	Samples []NetqualitySample `json:"samples"`
}
