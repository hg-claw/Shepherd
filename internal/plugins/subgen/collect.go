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
	Tag             string         `db:"tag"`
	Alias           string         `db:"alias"`
	Port            int            `db:"port"`
	Protocol        string         `db:"protocol"`
	Role            string         `db:"role"`
	RelayMode       string         `db:"relay_mode"`
	UUID            sql.NullString `db:"uuid"`
	Flow            sql.NullString `db:"flow"`
	Password        sql.NullString `db:"password"`
	SNI             sql.NullString `db:"sni"`
	RealityPub      sql.NullString `db:"reality_public_key"`
	RealitySID      sql.NullString `db:"reality_short_id"`
	TransportPath   sql.NullString `db:"transport_path"`
	TransportHost   sql.NullString `db:"transport_host"`
	SSMethod        sql.NullString `db:"ss_method"`
	ExtraJSON       sql.NullString `db:"extra_json"`
	UpProtocol      sql.NullString `db:"upstream_protocol"`
	UpUUID          sql.NullString `db:"upstream_uuid"`
	UpFlow          sql.NullString `db:"upstream_flow"`
	UpPassword      sql.NullString `db:"upstream_password"`
	UpSNI           sql.NullString `db:"upstream_sni"`
	UpRealityPub    sql.NullString `db:"upstream_reality_public_key"`
	UpRealitySID    sql.NullString `db:"upstream_reality_short_id"`
	UpTransportPath sql.NullString `db:"upstream_transport_path"`
	UpTransportHost sql.NullString `db:"upstream_transport_host"`
	UpSSMethod      sql.NullString `db:"upstream_ss_method"`
	UpExtraJSON     sql.NullString `db:"upstream_extra_json"`
	CertDomain      sql.NullString `db:"cert_domain"`
	UpCertDomain    sql.NullString `db:"upstream_cert_domain"`
	SrvName         string         `db:"srv_name"`
	SrvHost         sql.NullString `db:"srv_host"`
	SrvCountry      sql.NullString `db:"srv_country"`
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
		       u.protocol AS upstream_protocol, u.uuid AS upstream_uuid, u.flow AS upstream_flow,
		       u.password AS upstream_password, u.sni AS upstream_sni,
		       u.reality_public_key AS upstream_reality_public_key, u.reality_short_id AS upstream_reality_short_id,
		       u.transport_path AS upstream_transport_path, u.transport_host AS upstream_transport_host,
		       u.ss_method AS upstream_ss_method, u.extra_json AS upstream_extra_json,
		       c.domain AS cert_domain, uc.domain AS upstream_cert_domain,
		       s.name AS srv_name, s.ssh_host AS srv_host, s.country_code AS srv_country
		  FROM singbox_inbounds i
		  JOIN servers s ON s.id=i.server_id
		  LEFT JOIN singbox_inbounds u ON u.id=i.upstream_inbound_id
		  LEFT JOIN singbox_certificates c ON c.id=i.cert_id
		  LEFT JOIN singbox_certificates uc ON uc.id=u.cert_id
		 WHERE i.id=$1`, id)
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
		// Forward relays are transparent forwarders: the client connects to the
		// relay's host:port but speaks the LANDING's protocol/creds. Build the
		// node from the upstream landing, keeping the relay's own server:port.
		if !r.UpProtocol.Valid || r.UpProtocol.String == "" {
			return Node{}, fmt.Sprintf("singbox %s on %s: forward relay upstream landing missing, skipped", r.Tag, r.SrvName), nil
		}
		n := singboxInboundToNode(singboxLite{
			Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.UpProtocol.String, Role: r.Role, RelayMode: r.RelayMode,
			UUID: ns(r.UpUUID), Flow: ns(r.UpFlow), Password: ns(r.UpPassword), SNI: ns(r.UpSNI),
			RealityPublicKey: ns(r.UpRealityPub), RealityShortID: ns(r.UpRealitySID),
			TransportPath: ns(r.UpTransportPath), TransportHost: ns(r.UpTransportHost),
			SSMethod: ns(r.UpSSMethod), ExtraJSON: ns(r.UpExtraJSON),
			Insecure: certDomainMismatch(r.UpCertDomain.String, r.UpSNI),
		}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
		return n, "", nil
	}
	n := singboxInboundToNode(singboxLite{
		Tag: r.Tag, Alias: r.Alias, Port: r.Port, Protocol: r.Protocol, Role: r.Role, RelayMode: r.RelayMode,
		UUID: ns(r.UUID), Flow: ns(r.Flow), Password: ns(r.Password), SNI: ns(r.SNI),
		RealityPublicKey: ns(r.RealityPub), RealityShortID: ns(r.RealitySID),
		TransportPath: ns(r.TransportPath), TransportHost: ns(r.TransportHost),
		SSMethod: ns(r.SSMethod), ExtraJSON: ns(r.ExtraJSON),
		Insecure: certDomainMismatch(r.CertDomain.String, r.SNI),
	}, serverLite{Name: r.SrvName, Host: r.SrvHost.String, Country: r.SrvCountry.String})
	return n, "", nil
}

// certDomainMismatch reports whether a cert is present with a non-empty SNI that
// the cert does not cover — i.e. the client must skip cert verification.
func certDomainMismatch(certDomain string, sni sql.NullString) bool {
	if certDomain == "" || !sni.Valid || sni.String == "" {
		return false
	}
	return !certMatchesSNI(certDomain, sni.String)
}
