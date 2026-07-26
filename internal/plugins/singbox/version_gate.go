package singbox

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// requiresSingbox114 reports whether a protocol needs sing-box 1.14+.
// snell inbounds landed upstream in 1.14.0-alpha.38.
func requiresSingbox114(protocol string) bool {
	return protocol == "snell-v5" || protocol == "snell-v6"
}

// inboundNeeds114 reports whether a single inbound row makes sing-box
// 1.14 a hard requirement on the host it lives on.
//
// A forward-mode relay is the carve-out: renderInbound short-circuits it
// to {"type":"direct", "override_address":…} before the protocol switch
// ever runs, so no snell code path executes on that host. Such a row
// carries protocol="snell-v5" only to describe what the *landing*
// speaks — gating the relay host on 1.14 would defeat the whole point of
// forward mode (no per-relay protocol awareness, no credentials).
func inboundNeeds114(protocol, role, relayMode string) bool {
	if role == "relay" && relayMode == "forward" {
		return false
	}
	return requiresSingbox114(protocol)
}

// parseSingboxMinor extracts major.minor from a free-form version string.
// It tolerates a leading "v" and any pre-release suffix, so
// "v1.14.0-beta.2" parses as (1, 14). ok=false means the string is not a
// recognisable version at all — deployed_version is free-form and an
// unknown value must not silently pass a gate.
func parseSingboxMinor(version string) (major, minor int, ok bool) {
	s := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) < 2 {
		return 0, 0, false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, false
	}
	minor, err = strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, false
	}
	return major, minor, true
}

// singboxMinorAtLeast compares only major.minor, which is all the 1.14
// boundary needs. Unparseable input returns false.
func singboxMinorAtLeast(version string, wantMajor, wantMinor int) bool {
	major, minor, ok := parseSingboxMinor(version)
	if !ok {
		return false
	}
	if major != wantMajor {
		return major > wantMajor
	}
	return minor >= wantMinor
}

// describeDeployedVersion renders plugin_hosts.deployed_version for the
// gate's error message. The column is nullable and free-form: an empty
// value is the common case (every host installed before the version
// column was populated), and "has \"\"" reads like a bug rather than a
// diagnosis.
func describeDeployedVersion(version string) string {
	v := strings.TrimSpace(version)
	if v == "" {
		return "has no recorded version"
	}
	if _, _, ok := parseSingboxMinor(v); !ok {
		return fmt.Sprintf("has an unrecognised version %q", v)
	}
	return fmt.Sprintf("has %q", v)
}

// snellVersionGate verifies that serverID's recorded sing-box version can
// run the snell rows named in needs. Shared by the deploy-time gate
// (checkSnellVersionGate) and the create-handler pre-flight, so both
// speak with one voice.
func snellVersionGate(ctx context.Context, db *sqlx.DB, serverID int64, needs []string) error {
	if len(needs) == 0 {
		return nil
	}
	store := &plugins.Store{DB: db}
	host, err := store.GetHost(ctx, "singbox", serverID)
	if err != nil {
		return fmt.Errorf("snell inbounds %v require sing-box 1.14+, but the deployed version is unknown: %w", needs, err)
	}
	if !singboxMinorAtLeast(host.DeployedVersion.String, 1, 14) {
		return fmt.Errorf("snell inbounds %v require sing-box 1.14+, server %d %s — upgrade it on the Deploy tab first",
			needs, serverID, describeDeployedVersion(host.DeployedVersion.String))
	}
	return nil
}

// checkSnellVersionGate refuses to deploy a config containing snell
// inbounds to a host running sing-box older than 1.14. Without this the
// binary rejects the config with a FATAL in journalctl that the panel
// never surfaces — plugin_hosts.deployed_version records what we told the
// agent to install, it is never measured.
func checkSnellVersionGate(ctx context.Context, db *sqlx.DB, serverID int64, views []InboundView) error {
	var needs []string
	for _, v := range views {
		if inboundNeeds114(v.Protocol, v.Role, v.RelayMode) {
			needs = append(needs, v.Tag)
		}
	}
	return snellVersionGate(ctx, db, serverID, needs)
}
