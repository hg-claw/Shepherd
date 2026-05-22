package singbox

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/deploy"
)

const (
	singboxBinaryRemotePath     = "/usr/local/bin/shepherd-singbox"
	singboxConfigRemotePath     = "/etc/shepherd-singbox/config.json"
	singboxCertDir              = "/etc/shepherd-singbox/certs"
	singboxUnitRemotePathLinux  = "/etc/systemd/system/shepherd-singbox.service"
	singboxUnitRemotePathDarwin = "/Library/LaunchDaemons/com.shepherd.singbox.plist"
	singboxUnitNameLinux        = "shepherd-singbox"
	singboxUnitNameDarwin       = "com.shepherd.singbox"
)

// AssembleAndDeploy renders and deploys the sing-box config for serverID.
// Steps:
//  1. Load all inbounds; filter to those belonging to serverID.
//  2. If zero inbounds: stop sing-box, return.
//  3. Collect unique cert IDs; fetch CertViews; push cert + key files to host.
//  4. Render config JSON; push to host.
//  5. Restart sing-box (systemctl restart / launchctl bootout+bootstrap).
func AssembleAndDeploy(ctx context.Context, deps plugins.Deps, serverID int64) error {
	store := &InboundStore{DB: deps.DB}
	allViews, err := store.ListAllWithUpstream(ctx)
	if err != nil {
		return fmt.Errorf("list inbounds: %w", err)
	}

	mine := make([]InboundView, 0)
	for _, v := range allViews {
		if v.ServerID == serverID {
			mine = append(mine, v)
		}
	}

	osName, _ := sbHostOSArch(ctx, deps.DB, serverID)
	unitName := singboxUnitNameLinux
	if osName == "darwin" {
		unitName = singboxUnitNameDarwin
	}
	pusher := &deploy.Pusher{Exec: deps.HostExec}

	if len(mine) == 0 {
		return pusher.Stop(ctx, osName, serverID, unitName)
	}

	// Collect unique cert IDs referenced by this server's inbounds.
	certIDSet := map[int64]struct{}{}
	for _, v := range mine {
		if v.CertID != nil {
			certIDSet[*v.CertID] = struct{}{}
		}
	}
	certIDs := make([]int64, 0, len(certIDSet))
	for id := range certIDSet {
		certIDs = append(certIDs, id)
	}

	cs := &CertStore{DB: deps.DB}
	certViews, err := cs.GetViewsByIDs(ctx, certIDs)
	if err != nil {
		return fmt.Errorf("load certs: %w", err)
	}

	// Push cert and key files to the host.
	for _, cv := range certViews {
		crtPath, keyPath := CertFilePath(configDir, cv.Domain)
		if err := deps.HostExec.PushFile(ctx, serverID, crtPath, 0600, []byte(cv.CertPEM)); err != nil {
			return fmt.Errorf("push cert %s: %w", crtPath, err)
		}
		if err := deps.HostExec.PushFile(ctx, serverID, keyPath, 0600, []byte(cv.KeyPEM)); err != nil {
			return fmt.Errorf("push key %s: %w", keyPath, err)
		}
	}

	// Render and push config.
	cfgBytes, err := RenderServerConfig(mine, certViews)
	if err != nil {
		return fmt.Errorf("render config: %w", err)
	}
	if err := deps.HostExec.PushFile(ctx, serverID, singboxConfigRemotePath, 0600, cfgBytes); err != nil {
		return fmt.Errorf("push config: %w", err)
	}

	// Restart sing-box. Always restart (not reload) — sing-box does not honor
	// SIGHUP cleanly, same pattern as xray.
	if osName == "darwin" {
		// launchd: bootout (tolerate failure if not loaded), then bootstrap.
		_, _, _, _ = deps.HostExec.RunCmd(ctx, serverID, "launchctl", "bootout", "system", singboxUnitRemotePathDarwin)
		if _, _, _, err := deps.HostExec.RunCmd(ctx, serverID, "launchctl", "bootstrap", "system", singboxUnitRemotePathDarwin); err != nil {
			return fmt.Errorf("launchctl bootstrap: %w", err)
		}
		return nil
	}
	if _, _, _, err := deps.HostExec.RunCmd(ctx, serverID, "systemctl", "restart", unitName); err != nil {
		return fmt.Errorf("systemctl restart %s: %w", unitName, err)
	}
	return nil
}

// sbHostOSArch reads servers.agent_os / agent_arch for the target server,
// defaulting to linux/amd64 when they are NULL (unenrolled or pre-Phase-2 row).
func sbHostOSArch(ctx context.Context, db *sqlx.DB, serverID int64) (string, string) {
	var osName, arch sql.NullString
	_ = db.QueryRowxContext(ctx,
		"SELECT agent_os, agent_arch FROM servers WHERE id=$1", serverID).
		Scan(&osName, &arch)
	o := "linux"
	if osName.Valid && osName.String != "" {
		o = osName.String
	}
	a := "amd64"
	if arch.Valid && arch.String != "" {
		a = arch.String
	}
	return o, a
}
