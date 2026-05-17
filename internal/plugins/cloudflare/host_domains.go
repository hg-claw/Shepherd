package cloudflare

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type addDomainBody struct {
	ServerID int64  `json:"server_id"`
	Domain   string `json:"domain"`  // optional — when empty, build from prefix + server.name
	Content  string `json:"content"` // optional — when empty, use server.ssh_host
	Type     string `json:"type"`    // optional — default "A"
}

type hostDomainRow struct {
	ID        int64  `json:"id"`
	ServerID  int64  `json:"server_id"`
	ZoneID    string `json:"zone_id"`
	RecordID  string `json:"record_id"`
	Domain    string `json:"domain"`
	Type      string `json:"type"`
	Content   string `json:"content"`
	CreatedAt string `json:"created_at"`
}

type pluginCfg struct {
	APIToken string `json:"api_token"`
	ZoneID   string `json:"zone_id"`
	Prefix   string `json:"prefix"`
}

func (p *Plugin) loadCfg(ctx context.Context) (pluginCfg, error) {
	row, err := p.store.Get(ctx, "cloudflare")
	if err != nil {
		return pluginCfg{}, err
	}
	var c pluginCfg
	_ = json.Unmarshal(row.ConfigJSON, &c)
	return c, nil
}

func (p *Plugin) listHostDomains(ctx context.Context, serverIDStr string) ([]hostDomainRow, error) {
	q := "SELECT id, server_id, zone_id, COALESCE(record_id,''), domain, type, content, created_at FROM cf_host_domains"
	args := []any{}
	if serverIDStr != "" {
		q += " WHERE server_id=?"
		args = append(args, serverIDStr)
	}
	q += " ORDER BY server_id, domain"
	rows, err := p.store.DB.QueryxContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []hostDomainRow{}
	for rows.Next() {
		var r hostDomainRow
		var ts time.Time
		if err := rows.Scan(&r.ID, &r.ServerID, &r.ZoneID, &r.RecordID, &r.Domain, &r.Type, &r.Content, &ts); err != nil {
			return nil, err
		}
		r.CreatedAt = ts.UTC().Format(time.RFC3339)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (p *Plugin) addHostDomain(ctx context.Context, c *Client, body addDomainBody) (hostDomainRow, error) {
	cfg, err := p.loadCfg(ctx)
	if err != nil {
		return hostDomainRow{}, err
	}
	if cfg.ZoneID == "" {
		return hostDomainRow{}, errors.New("plugin zone_id not configured")
	}
	if body.ServerID == 0 {
		return hostDomainRow{}, errors.New("server_id required")
	}
	srv, err := p.fetchServer(ctx, body.ServerID)
	if err != nil {
		return hostDomainRow{}, err
	}

	domain := strings.TrimSpace(body.Domain)
	if domain == "" {
		if cfg.Prefix == "" {
			return hostDomainRow{}, errors.New("prefix not configured and domain not supplied")
		}
		// Build {server.name}.{prefix}.{zoneApex}. We don't know the zone apex
		// from cfg alone — fetch zone name via CF.
		apex, err := p.zoneApex(ctx, c, cfg.ZoneID)
		if err != nil {
			return hostDomainRow{}, err
		}
		domain = fmt.Sprintf("%s.%s.%s", srv.Name, cfg.Prefix, apex)
	}
	content := strings.TrimSpace(body.Content)
	if content == "" {
		content = srv.SSHHost
	}
	if content == "" {
		return hostDomainRow{}, errors.New("content empty and server has no ssh_host")
	}
	rtype := body.Type
	if rtype == "" {
		rtype = "A"
	}

	// Create CF record first, then persist locally with the CF record_id so we
	// never have a local row pointing at a non-existent CF record.
	cfBody := map[string]any{
		"type":    rtype,
		"name":    domain,
		"content": content,
		"ttl":     1,
		"proxied": false,
	}
	cfOut, err := c.CreateRecord(ctx, cfg.ZoneID, cfBody)
	if err != nil {
		return hostDomainRow{}, err
	}
	recID, _ := cfOut["id"].(string)

	now := p.store.Now().UTC()
	res, err := p.store.DB.ExecContext(ctx,
		`INSERT INTO cf_host_domains(server_id, zone_id, record_id, domain, type, content, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		body.ServerID, cfg.ZoneID, recID, domain, rtype, content, now)
	if err != nil {
		// best-effort rollback of the CF record we just created
		if recID != "" {
			_ = c.DeleteRecord(ctx, cfg.ZoneID, recID)
		}
		return hostDomainRow{}, err
	}
	id, _ := res.LastInsertId()
	return hostDomainRow{
		ID: id, ServerID: body.ServerID, ZoneID: cfg.ZoneID, RecordID: recID,
		Domain: domain, Type: rtype, Content: content,
		CreatedAt: now.Format(time.RFC3339),
	}, nil
}

func (p *Plugin) deleteHostDomain(ctx context.Context, c *Client, id int64) error {
	var zoneID, recordID string
	err := p.store.DB.GetContext(ctx, &recordID,
		"SELECT COALESCE(record_id,'') FROM cf_host_domains WHERE id=?", id)
	if err != nil {
		return err
	}
	_ = p.store.DB.GetContext(ctx, &zoneID,
		"SELECT zone_id FROM cf_host_domains WHERE id=?", id)
	if recordID != "" && zoneID != "" {
		_ = c.DeleteRecord(ctx, zoneID, recordID) // best-effort; if CF record is already gone we still want the local row to vanish
	}
	_, err = p.store.DB.ExecContext(ctx, "DELETE FROM cf_host_domains WHERE id=?", id)
	return err
}

// minimal server view for domain construction
type serverInfo struct {
	ID      int64  `db:"id"`
	Name    string `db:"name"`
	SSHHost string `db:"ssh_host"`
}

func (p *Plugin) fetchServer(ctx context.Context, id int64) (serverInfo, error) {
	var s serverInfo
	var sshHost sql.NullString
	row := p.store.DB.QueryRowxContext(ctx,
		"SELECT id, name, ssh_host FROM servers WHERE id=?", id)
	if err := row.Scan(&s.ID, &s.Name, &sshHost); err != nil {
		return serverInfo{}, err
	}
	if sshHost.Valid {
		s.SSHHost = sshHost.String
	}
	return s, nil
}

// zoneApex looks up the zone name for the given zone ID from CF.
func (p *Plugin) zoneApex(ctx context.Context, c *Client, zoneID string) (string, error) {
	zones, err := c.ListZones(ctx)
	if err != nil {
		return "", err
	}
	for _, z := range zones {
		if id, _ := z["id"].(string); id == zoneID {
			if name, _ := z["name"].(string); name != "" {
				return name, nil
			}
		}
	}
	return "", fmt.Errorf("zone %s not found", zoneID)
}

// Silence unused-import nag if json is only used inside the helper.
var _ = http.StatusOK
