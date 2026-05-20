package agentapi

import "time"

// Type constants — keep in lockstep with spec §5.
const (
	TypeConfigUpdate = "config.update"
	TypePing         = "ping"
	TypePong         = "pong"
	TypeHeartbeat    = "heartbeat"
	TypeTelemetry    = "telemetry"
	TypeXrayTraffic  = "xray.traffic"
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
}

type Heartbeat struct {
	TS           time.Time    `json:"ts"`
	AgentVersion string       `json:"agent_version"`
	OS           string       `json:"os"`
	Arch         string       `json:"arch"`
	Kernel       string       `json:"kernel"`
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
