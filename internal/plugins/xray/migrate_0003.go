package xray

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/jmoiron/sqlx"
)

// Migrate0003 fills xray_inbounds from legacy plugin_hosts.config (vless-reality
// shape only — vmess/shadowsocks were never shipped in production). Idempotent.
// Call AFTER the 0003 SQL migration has applied (guaranteed when
// RunPluginMigrations has returned nil for plugin "xray").
func Migrate0003(ctx context.Context, db *sqlx.DB) error {
	type legacyRow struct {
		ServerID         int64          `db:"server_id"`
		Config           []byte         `db:"config_json"`
		Role             sql.NullString `db:"role"`
		UpstreamServerID sql.NullInt64  `db:"upstream_server_id"`
	}
	rows := []legacyRow{}
	err := db.SelectContext(ctx, &rows, `
		SELECT ph.server_id, ph.config_json, ht.role, ht.upstream_server_id
		FROM plugin_hosts ph
		LEFT JOIN xray_host_topology ht ON ht.server_id = ph.server_id
		WHERE ph.plugin_id = 'xray'
		ORDER BY ph.server_id`)
	if err != nil {
		return fmt.Errorf("query legacy plugin_hosts: %w", err)
	}

	store := &InboundStore{DB: db}
	serverToInboundID := map[int64]int64{}

	// Pass 1: insert landing rows only (relay rows defer to pass 2 since
	// the CHECK constraint forbids relay with NULL upstream).
	for _, r := range rows {
		port, uuid, sni, pubk, privk, sid, ok := extractVlessRealityFields(r.Config)
		if !ok {
			continue
		}

		role := "landing"
		if r.Role.Valid && r.Role.String == "relay" {
			role = "relay"
		}

		// Idempotency: did we already migrate this server?
		var existingID int64
		if err := db.GetContext(ctx, &existingID,
			`SELECT id FROM xray_inbounds WHERE server_id=? AND port=?`, r.ServerID, port); err == nil {
			serverToInboundID[r.ServerID] = existingID
			continue
		}

		if role == "relay" {
			continue // pass 2 handles relays
		}

		id, err := store.Insert(ctx, Inbound{
			ServerID:          r.ServerID,
			Tag:               store.GenerateTag(role),
			Port:              port,
			Role:              role,
			Protocol:          "vless-reality",
			UUID:              uuid,
			SNI:               sni,
			PublicKey:         pubk,
			PrivateKey:        privk,
			ShortID:           sid,
			UpstreamInboundID: nil,
		})
		if err != nil {
			return fmt.Errorf("insert landing for server %d: %w", r.ServerID, err)
		}
		serverToInboundID[r.ServerID] = id
	}

	// Pass 2: insert relay rows now that their upstream landing IDs are known.
	for _, r := range rows {
		if !r.Role.Valid || r.Role.String != "relay" {
			continue
		}
		port, uuid, sni, pubk, privk, sid, ok := extractVlessRealityFields(r.Config)
		if !ok {
			continue
		}

		var existingID int64
		if err := db.GetContext(ctx, &existingID,
			`SELECT id FROM xray_inbounds WHERE server_id=? AND port=?`, r.ServerID, port); err == nil {
			serverToInboundID[r.ServerID] = existingID
			continue
		}

		if !r.UpstreamServerID.Valid {
			continue // orphan relay; skip
		}
		upstreamID, ok := serverToInboundID[r.UpstreamServerID.Int64]
		if !ok {
			continue // upstream landing wasn't migrated; skip
		}

		id, err := store.Insert(ctx, Inbound{
			ServerID:          r.ServerID,
			Tag:               store.GenerateTag("relay"),
			Port:              port,
			Role:              "relay",
			Protocol:          "vless-reality",
			UUID:              uuid,
			SNI:               sni,
			PublicKey:         pubk,
			PrivateKey:        privk,
			ShortID:           sid,
			UpstreamInboundID: &upstreamID,
		})
		if err != nil {
			return fmt.Errorf("insert relay for server %d: %w", r.ServerID, err)
		}
		serverToInboundID[r.ServerID] = id
	}

	// Clear plugin_hosts.config_json for all xray rows (no longer used).
	if _, err := db.ExecContext(ctx,
		`UPDATE plugin_hosts SET config_json='{}' WHERE plugin_id='xray' AND config_json != '{}'`); err != nil {
		return fmt.Errorf("clear plugin_hosts.config_json: %w", err)
	}
	return nil
}

// extractVlessRealityFields parses inbounds[0] of a legacy xray config.json.
// Returns (port, uuid, sni, publicKey, privateKey, shortID, ok). ok=false on
// any malformed input — callers should skip the row.
func extractVlessRealityFields(raw []byte) (int, string, string, string, string, string, bool) {
	if len(raw) == 0 {
		return 0, "", "", "", "", "", false
	}
	var cfg map[string]any
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return 0, "", "", "", "", "", false
	}
	inbounds, _ := cfg["inbounds"].([]any)
	if len(inbounds) == 0 {
		return 0, "", "", "", "", "", false
	}
	first, _ := inbounds[0].(map[string]any)
	if first == nil {
		return 0, "", "", "", "", "", false
	}
	portF, _ := first["port"].(float64)
	port := int(portF)
	settings, _ := first["settings"].(map[string]any)
	clients, _ := settings["clients"].([]any)
	uuid := ""
	if len(clients) > 0 {
		c0, _ := clients[0].(map[string]any)
		uuid, _ = c0["id"].(string)
	}
	ss, _ := first["streamSettings"].(map[string]any)
	rs, _ := ss["realitySettings"].(map[string]any)
	sni := ""
	if names, _ := rs["serverNames"].([]any); len(names) > 0 {
		sni, _ = names[0].(string)
	}
	pubk, _ := rs["publicKey"].(string)
	privk, _ := rs["privateKey"].(string)
	shortID := ""
	if sids, _ := rs["shortIds"].([]any); len(sids) > 0 {
		shortID, _ = sids[0].(string)
	}
	if port == 0 || uuid == "" || sni == "" {
		return 0, "", "", "", "", "", false
	}
	return port, uuid, sni, pubk, privk, shortID, true
}
