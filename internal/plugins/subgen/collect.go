package subgen

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/jmoiron/sqlx"
)

func CollectNodes(ctx context.Context, db *sqlx.DB, sels []Selection) ([]Node, []string, error) {
	var nodes []Node
	var warns []string
	for _, sel := range sels {
		switch sel.Source {
		case "xray":
			n, w, err := collectXray(ctx, db, sel.InboundID)
			if err != nil {
				return nil, nil, err
			}
			if w != "" {
				warns = append(warns, w)
			} else {
				nodes = append(nodes, n)
			}
		case "singbox":
			n, w, err := collectSingbox(ctx, db, sel.InboundID)
			if err != nil {
				return nil, nil, err
			}
			if w != "" {
				warns = append(warns, w)
			} else {
				nodes = append(nodes, n)
			}
		default:
			warns = append(warns, fmt.Sprintf("unknown source %q for inbound %d", sel.Source, sel.InboundID))
		}
	}
	return nodes, warns, nil
}

type xrayRow struct {
	Tag        string         `db:"tag"`
	Alias      string         `db:"alias"`
	Port       int            `db:"port"`
	Protocol   string         `db:"protocol"`
	UUID       sql.NullString `db:"uuid"`
	SNI        sql.NullString `db:"sni"`
	PublicKey  sql.NullString `db:"public_key"`
	ShortID    sql.NullString `db:"short_id"`
	WSPath     sql.NullString `db:"ws_path"`
	SSMethod   sql.NullString `db:"ss_method"`
	SSPassword sql.NullString `db:"ss_password"`
	SrvName    string         `db:"srv_name"`
	SrvHost    sql.NullString `db:"srv_host"`
	SrvCountry sql.NullString `db:"srv_country"`
}

func collectXray(ctx context.Context, db *sqlx.DB, id int64) (Node, string, error) {
	var r xrayRow
	err := db.GetContext(ctx, &r, `
		SELECT i.tag, COALESCE(i.alias,'') AS alias, i.port, i.protocol, i.uuid, i.sni, i.public_key, i.short_id,
		       i.ws_path, i.ss_method, i.ss_password,
		       s.name AS srv_name, s.ssh_host AS srv_host, s.country_code AS srv_country
		  FROM xray_inbounds i JOIN servers s ON s.id=i.server_id WHERE i.id=$1`, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Node{}, fmt.Sprintf("xray inbound %d not found", id), nil
		}
		return Node{}, "", err
	}
	if !r.SrvHost.Valid || r.SrvHost.String == "" {
		return Node{}, fmt.Sprintf("xray %s on %s: no ssh_host, skipped", r.Tag, r.SrvName), nil
	}
	n := xrayInboundToNode(xrayLite{
		Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.Protocol,
		UUID: r.UUID.String, SNI: r.SNI.String, PublicKey: r.PublicKey.String,
		ShortID: r.ShortID.String, WSPath: r.WSPath.String,
		SSMethod: r.SSMethod.String, SSPassword: r.SSPassword.String,
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
	return n, "", nil
}

type singboxRow struct {
	Tag           string         `db:"tag"`
	Alias         string         `db:"alias"`
	Port          int            `db:"port"`
	Protocol      string         `db:"protocol"`
	Role          string         `db:"role"`
	RelayMode     string         `db:"relay_mode"`
	UUID          sql.NullString `db:"uuid"`
	Flow          sql.NullString `db:"flow"`
	Password      sql.NullString `db:"password"`
	SNI           sql.NullString `db:"sni"`
	RealityPub    sql.NullString `db:"reality_public_key"`
	RealitySID    sql.NullString `db:"reality_short_id"`
	TransportPath sql.NullString `db:"transport_path"`
	TransportHost sql.NullString `db:"transport_host"`
	SSMethod      sql.NullString `db:"ss_method"`
	ExtraJSON     sql.NullString `db:"extra_json"`
	SrvName       string         `db:"srv_name"`
	SrvHost       sql.NullString `db:"srv_host"`
	SrvCountry    sql.NullString `db:"srv_country"`
}

func ns(v sql.NullString) *string {
	if v.Valid {
		s := v.String
		return &s
	}
	return nil
}

func collectSingbox(ctx context.Context, db *sqlx.DB, id int64) (Node, string, error) {
	var r singboxRow
	err := db.GetContext(ctx, &r, `
		SELECT i.tag, COALESCE(i.alias,'') AS alias, i.port, i.protocol, i.role, i.relay_mode, i.uuid, i.flow, i.password, i.sni,
		       i.reality_public_key, i.reality_short_id, i.transport_path, i.transport_host,
		       i.ss_method, i.extra_json,
		       s.name AS srv_name, s.ssh_host AS srv_host, s.country_code AS srv_country
		  FROM singbox_inbounds i JOIN servers s ON s.id=i.server_id WHERE i.id=$1`, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Node{}, fmt.Sprintf("singbox inbound %d not found", id), nil
		}
		return Node{}, "", err
	}
	if !r.SrvHost.Valid || r.SrvHost.String == "" {
		return Node{}, fmt.Sprintf("singbox %s on %s: no ssh_host, skipped", r.Tag, r.SrvName), nil
	}
	if r.Role == "relay" && r.RelayMode == "forward" {
		return Node{}, fmt.Sprintf("singbox %s on %s: forward-mode relay not supported in subscriptions, skipped", r.Tag, r.SrvName), nil
	}
	n := singboxInboundToNode(singboxLite{
		Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.Protocol, Role: r.Role, RelayMode: r.RelayMode,
		UUID: ns(r.UUID), Flow: ns(r.Flow), Password: ns(r.Password), SNI: ns(r.SNI),
		RealityPublicKey: ns(r.RealityPub), RealityShortID: ns(r.RealitySID),
		TransportPath: ns(r.TransportPath), TransportHost: ns(r.TransportHost),
		SSMethod: ns(r.SSMethod), ExtraJSON: ns(r.ExtraJSON),
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
	return n, "", nil
}
