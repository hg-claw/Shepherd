package api

import (
	"context"
	"net/http"

	"github.com/hg-claw/Shepherd/internal/serversvc"
)

type SettingsAPI struct {
	Settings *serversvc.SettingsStore
	// OnSandboxChange, if set, is called after a Patch that touched any of
	// the sandbox-related keys. cmd/server wires it to SandboxPusher.PushAll
	// so existing online agents pick up the new whitelist without reconnect.
	OnSandboxChange func(ctx context.Context)
}

var allowedSettingKeys = map[string]bool{
	// Phase 1
	"public_display_mode":                true,
	"retention_30s":                      true,
	"retention_5m":                       true,
	"retention_1h":                       true,
	"default_telemetry_interval_seconds": true,
	// Phase 2 (added by 0002 migration)
	"file_sandbox_enabled":         true,
	"file_sandbox_paths":           true,
	"audit_retention_days":         true,
	"pty_recording_enabled":        true,
	"pty_max_concurrent_per_admin": true,
	"file_upload_max_bytes":        true,
	"file_chunk_bytes":             true,
	// Phase 3 (CN mirror for plugin binary downloads)
	"cn_mirror_enabled": true,
	// Phase 4 (agent verbose log toggle, runtime push to online agents)
	"agent_log_verbose": true,
}

// Keys that, when changed, require a re-push of the agent config snapshot
// to online agents. ConfigUpdate carries the union of these keys, so any of
// them flipping fans out the whole snapshot via SandboxPusher.PushAll.
var sandboxPushKeys = map[string]bool{
	"file_sandbox_enabled": true,
	"file_sandbox_paths":   true,
	"agent_log_verbose":    true,
}

func (a *SettingsAPI) GetAll(w http.ResponseWriter, r *http.Request) {
	m, err := a.Settings.GetAll(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, m)
}

func (a *SettingsAPI) Patch(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	for k := range in {
		if !allowedSettingKeys[k] {
			writeError(w, 400, "unknown setting key: "+k)
			return
		}
	}
	pushSandbox := false
	for k, v := range in {
		if err := a.Settings.Set(r.Context(), k, v); err != nil {
			writeError(w, 500, err.Error())
			return
		}
		if sandboxPushKeys[k] {
			pushSandbox = true
		}
	}
	if pushSandbox && a.OnSandboxChange != nil {
		a.OnSandboxChange(r.Context())
	}
	a.GetAll(w, r)
}
