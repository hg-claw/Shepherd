package agentapi

import "time"

// Type constants — keep in lockstep with spec §5.
const (
	TypeConfigUpdate = "config.update"
	TypePing         = "ping"
	TypePong         = "pong"
	TypeHeartbeat    = "heartbeat"
	TypeTelemetry    = "telemetry"
)

type ConfigUpdate struct {
	TelemetryIntervalSeconds int      `json:"telemetry_interval_seconds,omitempty"`
	FileSandboxEnabled       *bool    `json:"file_sandbox_enabled,omitempty"`
	FileSandboxPaths         []string `json:"file_sandbox_paths,omitempty"`
}

type Heartbeat struct {
	TS           time.Time `json:"ts"`
	AgentVersion string    `json:"agent_version"`
	OS           string    `json:"os"`
	Arch         string    `json:"arch"`
	Kernel       string    `json:"kernel"`
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

type EnrollRequest struct {
	EnrollmentToken string `json:"enrollment_token"`
	Fingerprint     string `json:"fingerprint"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	Kernel          string `json:"kernel"`
	AgentVersion    string `json:"agent_version"`
}

type EnrollResponse struct {
	MachineToken string `json:"machine_token"`
	ServerID     int64  `json:"server_id"`
}

type AutoRegisterRequest struct {
	AutoRecoverKey string `json:"auto_recover_key"`
	Fingerprint    string `json:"fingerprint"`
	Hostname       string `json:"hostname"`
	OS             string `json:"os"`
	Arch           string `json:"arch"`
	Kernel         string `json:"kernel"`
	AgentVersion   string `json:"agent_version"`
}
