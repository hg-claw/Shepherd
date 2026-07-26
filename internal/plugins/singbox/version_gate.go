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

// singboxMinorAtLeast compares only major.minor, which is all the 1.14
// boundary needs. It tolerates a leading "v" and any pre-release suffix,
// so "v1.14.0-beta.2" counts as 1.14. Unparseable input returns false —
// deployed_version is free-form and an unknown value must not silently
// pass a gate.
func singboxMinorAtLeast(version string, wantMajor, wantMinor int) bool {
	s := strings.TrimPrefix(strings.TrimSpace(version), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) < 2 {
		return false
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return false
	}
	if major != wantMajor {
		return major > wantMajor
	}
	return minor >= wantMinor
}

// checkSnellVersionGate refuses to deploy a config containing snell
// inbounds to a host running sing-box older than 1.14. Without this the
// binary rejects the config with a FATAL in journalctl that the panel
// never surfaces — plugin_hosts.deployed_version records what we told the
// agent to install, it is never measured.
func checkSnellVersionGate(ctx context.Context, db *sqlx.DB, serverID int64, views []InboundView) error {
	var needs []string
	for _, v := range views {
		if requiresSingbox114(v.Protocol) {
			needs = append(needs, v.Tag)
		}
	}
	if len(needs) == 0 {
		return nil
	}
	store := &plugins.Store{DB: db}
	host, err := store.GetHost(ctx, "singbox", serverID)
	if err != nil {
		return fmt.Errorf("snell inbounds %v require sing-box 1.14+, but the deployed version is unknown: %w", needs, err)
	}
	if !singboxMinorAtLeast(host.DeployedVersion.String, 1, 14) {
		return fmt.Errorf("snell inbounds %v require sing-box 1.14+, server %d has %q — upgrade it on the Deploy tab first",
			needs, serverID, host.DeployedVersion.String)
	}
	return nil
}
