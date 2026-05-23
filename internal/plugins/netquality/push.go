package netquality

import (
	"context"
	"log"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// PushConfig assembles the current netquality config for one server and
// sends it down the WebSocket via sendFn (typically Hub.Send, supplied
// either through plugins.Deps.HubSend or wired directly in main.go).
//
// Called from AgentAPI.PushNetquality on every WS connect, and re-called
// by the admin endpoints (PR #3) whenever a target is added/removed or
// the host's enable/interval flips.
//
// "Disabled" is encoded as Targets=nil so the agent's sampler short-
// circuits without us having to invent a separate "off" signal.
func PushConfig(
	ctx context.Context,
	db *sqlx.DB,
	sendFn func(serverID int64, env agentapi.Envelope) error,
	serverID int64,
) {
	if sendFn == nil {
		return
	}
	cfg, err := buildConfig(ctx, db, serverID)
	if err != nil {
		log.Printf("netquality push (server=%d): build: %v", serverID, err)
		return
	}
	env, err := agentapi.Frame(agentapi.TypeNetqualityConfig, cfg)
	if err != nil {
		log.Printf("netquality push (server=%d): frame: %v", serverID, err)
		return
	}
	if err := sendFn(serverID, env); err != nil {
		// "agent offline" is the normal case during config edits while
		// the host is down — log at info level only to avoid spamming.
		log.Printf("netquality push (server=%d): %v", serverID, err)
	}
}

// buildConfig reads the host's enabled+interval row joined against the
// catalog. When the host has never been configured (no netquality_hosts
// row) we return an empty config — same shape as "disabled".
func buildConfig(ctx context.Context, db *sqlx.DB, serverID int64) (agentapi.NetqualityConfig, error) {
	var host struct {
		Enabled               bool `db:"enabled"`
		SampleIntervalSeconds int  `db:"sample_interval_seconds"`
	}
	err := db.GetContext(ctx, &host, `
		SELECT enabled, sample_interval_seconds
		  FROM netquality_hosts WHERE server_id = $1`, serverID)
	if err != nil {
		return agentapi.NetqualityConfig{}, nil
	}
	if !host.Enabled {
		return agentapi.NetqualityConfig{IntervalSeconds: host.SampleIntervalSeconds}, nil
	}
	// Per-host target selection (added in PR #58). The set of targets a
	// host samples is the intersection of (a) globally-enabled targets
	// from the catalog and (b) the per-host opt-in rows from
	// netquality_host_targets. A host with no rows in that table
	// samples nothing — the operator must pick. seedHostTargets in
	// routes.go fills the table on the first enable transition so
	// pre-existing hosts keep working out of the box.
	var targets []agentapi.NetqualityTarget
	if err := db.SelectContext(ctx, &targets, `
		SELECT t.id, t.host
		  FROM netquality_targets t
		  JOIN netquality_host_targets ht
		    ON ht.target_id = t.id AND ht.server_id = $1 AND ht.enabled = true
		 WHERE t.enabled = true
		 ORDER BY t.id`, serverID); err != nil {
		return agentapi.NetqualityConfig{}, err
	}
	return agentapi.NetqualityConfig{
		Targets:         targets,
		IntervalSeconds: host.SampleIntervalSeconds,
	}, nil
}
