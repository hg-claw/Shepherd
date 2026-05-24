package singbox

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"
)

// Inbound is the raw DB row for singbox_inbounds.
// Field names mirror the column names in the migration (snake_case → CamelCase).
// extra_json is stored as *string (JSON text); callers unmarshal as needed.
type Inbound struct {
	ID                     int64      `db:"id"`
	ServerID               int64      `db:"server_id"`
	Tag                    string     `db:"tag"`
	Port                   int        `db:"port"`
	Role                   string     `db:"role"`     // "landing" | "relay"
	Protocol               string     `db:"protocol"` // e.g. "vless-reality", "hysteria2"
	UUID                   *string    `db:"uuid"`
	Flow                   *string    `db:"flow"`
	Password               *string    `db:"password"`
	SNI                    *string    `db:"sni"`
	CertID                 *int64     `db:"cert_id"`
	RealityPrivateKey      *string    `db:"reality_private_key"`
	RealityPublicKey       *string    `db:"reality_public_key"`
	RealityShortID         *string    `db:"reality_short_id"`
	RealityHandshakeServer *string    `db:"reality_handshake_server"`
	RealityHandshakePort   *int64     `db:"reality_handshake_port"`
	TransportPath          *string    `db:"transport_path"`
	TransportHost          *string    `db:"transport_host"`
	AlterID                *int64     `db:"alter_id"`
	SSMethod               *string    `db:"ss_method"`
	UpstreamInboundID      *int64     `db:"upstream_inbound_id"`
	// RelayMode is meaningful only when Role=="relay":
	//   "proxy"   = legacy dual-termination (relay has its own keys)
	//   "forward" = transparent forwarder via sing-box "direct" inbound
	//               (no per-relay keys, client uses landing's URL with
	//               relay's IP:port).
	// On landings the column carries the DB default "proxy" but is ignored
	// by render. Set-once at insert; immutable via Patch.
	RelayMode              string     `db:"relay_mode"`
	ExtraJSON              *string    `db:"extra_json"` // raw JSON text; *string, not []byte
	CreatedAt              time.Time  `db:"created_at"`
	UpdatedAt              time.Time  `db:"updated_at"`
}

// InboundView extends Inbound with upstream JOIN fields and the own server name.
// Upstream fields are sql.Null* — NULL for landing rows (no upstream).
type InboundView struct {
	Inbound
	ServerName             string         `db:"server_name"`
	UpstreamTag            sql.NullString `db:"upstream_tag"`
	UpstreamPort           sql.NullInt64  `db:"upstream_port"`
	UpstreamServerID       sql.NullInt64  `db:"upstream_server_id"`
	UpstreamServerName     sql.NullString `db:"upstream_server_name"`
	UpstreamAddress        sql.NullString `db:"upstream_address"`
	UpstreamProtocol       sql.NullString `db:"upstream_protocol"`
	UpstreamUUID           sql.NullString `db:"upstream_uuid"`
	UpstreamPassword       sql.NullString `db:"upstream_password"`
	UpstreamSNI            sql.NullString `db:"upstream_sni"`
	UpstreamRealityPublicKey sql.NullString `db:"upstream_reality_public_key"`
	UpstreamRealityShortID   sql.NullString `db:"upstream_reality_short_id"`
	UpstreamTransportPath    sql.NullString `db:"upstream_transport_path"`
	UpstreamTransportHost    sql.NullString `db:"upstream_transport_host"`
	UpstreamSSMethod         sql.NullString `db:"upstream_ss_method"`
	UpstreamExtraJSON        sql.NullString `db:"upstream_extra_json"`
}

// InboundPatch carries mutable fields for Update. nil pointer = leave unchanged.
// Immutable post-create: server_id, tag, role, protocol, upstream_inbound_id.
type InboundPatch struct {
	Port                   *int
	UUID                   *string
	Flow                   *string
	Password               *string
	SNI                    *string
	CertID                 *int64
	RealityPrivateKey      *string
	RealityPublicKey       *string
	RealityShortID         *string
	RealityHandshakeServer *string
	RealityHandshakePort   *int64
	TransportPath          *string
	TransportHost          *string
	AlterID                *int64
	SSMethod               *string
	ExtraJSON              *string
}

// InboundStore is the DAO for singbox_inbounds.
type InboundStore struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *InboundStore) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

// GenerateTag returns "<role>-<8hex>" — unique on each call via crypto/rand.
func (s *InboundStore) GenerateTag(role string) string {
	var buf [4]byte
	_, _ = rand.Read(buf[:])
	return role + "-" + hex.EncodeToString(buf[:])
}

// Insert inserts a new inbound row. If in.Tag is empty, one is generated from in.Role.
func (s *InboundStore) Insert(ctx context.Context, in Inbound) (int64, error) {
	if in.Tag == "" {
		in.Tag = s.GenerateTag(in.Role)
	}
	if in.RelayMode == "" {
		// Match the DB-side DEFAULT so the Scan path back into the
		// Inbound struct reads the same value the caller saw written.
		in.RelayMode = "proxy"
	}
	now := s.now()
	var id int64
	if err := s.DB.QueryRowxContext(ctx, `
		INSERT INTO singbox_inbounds (
		  server_id, tag, port, role, protocol,
		  uuid, flow, password, sni, cert_id,
		  reality_private_key, reality_public_key, reality_short_id,
		  reality_handshake_server, reality_handshake_port,
		  transport_path, transport_host, alter_id, ss_method,
		  upstream_inbound_id, relay_mode, extra_json,
		  created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5, $6,$7,$8,$9,$10, $11,$12,$13, $14,$15, $16,$17,$18,$19, $20,$21,$22, $23,$24)
		RETURNING id`,
		in.ServerID, in.Tag, in.Port, in.Role, in.Protocol,
		in.UUID, in.Flow, in.Password, in.SNI, in.CertID,
		in.RealityPrivateKey, in.RealityPublicKey, in.RealityShortID,
		in.RealityHandshakeServer, in.RealityHandshakePort,
		in.TransportPath, in.TransportHost, in.AlterID, in.SSMethod,
		in.UpstreamInboundID, in.RelayMode, in.ExtraJSON,
		now, now).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

// GetByID fetches a single inbound by primary key.
func (s *InboundStore) GetByID(ctx context.Context, id int64) (Inbound, error) {
	var row Inbound
	err := s.DB.GetContext(ctx, &row, `SELECT * FROM singbox_inbounds WHERE id=$1`, id)
	return row, err
}

// ListByServer returns all inbounds for a given server, ordered by id.
func (s *InboundStore) ListByServer(ctx context.Context, serverID int64) ([]Inbound, error) {
	var rows []Inbound
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM singbox_inbounds WHERE server_id=$1 ORDER BY id`, serverID)
	return rows, err
}

// ListAllWithUpstream returns every inbound joined with its own server name,
// and (for relay rows) with the upstream inbound and its server's name/address.
func (s *InboundStore) ListAllWithUpstream(ctx context.Context) ([]InboundView, error) {
	var rows []InboundView
	err := s.DB.SelectContext(ctx, &rows, `
		SELECT
		  i.id, i.server_id, i.tag, i.port, i.role, i.protocol,
		  i.uuid, i.flow, i.password, i.sni, i.cert_id,
		  i.reality_private_key, i.reality_public_key, i.reality_short_id,
		  i.reality_handshake_server, i.reality_handshake_port,
		  i.transport_path, i.transport_host, i.alter_id, i.ss_method,
		  i.upstream_inbound_id, i.relay_mode, i.extra_json,
		  i.created_at, i.updated_at,
		  s.name                    AS server_name,
		  u.tag                     AS upstream_tag,
		  u.port                    AS upstream_port,
		  u.server_id               AS upstream_server_id,
		  us.name                   AS upstream_server_name,
		  us.ssh_host               AS upstream_address,
		  u.protocol                AS upstream_protocol,
		  u.uuid                    AS upstream_uuid,
		  u.password                AS upstream_password,
		  u.sni                     AS upstream_sni,
		  u.reality_public_key      AS upstream_reality_public_key,
		  u.reality_short_id        AS upstream_reality_short_id,
		  u.transport_path          AS upstream_transport_path,
		  u.transport_host          AS upstream_transport_host,
		  u.ss_method               AS upstream_ss_method,
		  u.extra_json              AS upstream_extra_json
		FROM singbox_inbounds i
		JOIN servers s ON s.id = i.server_id
		LEFT JOIN singbox_inbounds u  ON u.id = i.upstream_inbound_id
		LEFT JOIN servers us ON us.id = u.server_id
		ORDER BY i.server_id, i.id`)
	return rows, err
}

// ListByUpstream returns relay inbounds whose upstream_inbound_id equals landingID.
// Used for delete-validation: if non-empty, the landing cannot be deleted.
func (s *InboundStore) ListByUpstream(ctx context.Context, landingID int64) ([]Inbound, error) {
	var rows []Inbound
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM singbox_inbounds WHERE upstream_inbound_id=$1 ORDER BY id`, landingID)
	return rows, err
}

// Update applies non-nil fields from patch to the inbound with the given id.
// Immutable fields (server_id, tag, role, protocol, upstream_inbound_id) are not touched.
func (s *InboundStore) Update(ctx context.Context, id int64, patch InboundPatch) error {
	set := []string{}
	args := []any{}
	app := func(col string, val any) { set = append(set, col+"=?"); args = append(args, val) }

	if patch.Port != nil                   { app("port", *patch.Port) }
	if patch.UUID != nil                   { app("uuid", *patch.UUID) }
	if patch.Flow != nil                   { app("flow", *patch.Flow) }
	if patch.Password != nil               { app("password", *patch.Password) }
	if patch.SNI != nil                    { app("sni", *patch.SNI) }
	if patch.CertID != nil                 { app("cert_id", *patch.CertID) }
	if patch.RealityPrivateKey != nil      { app("reality_private_key", *patch.RealityPrivateKey) }
	if patch.RealityPublicKey != nil       { app("reality_public_key", *patch.RealityPublicKey) }
	if patch.RealityShortID != nil         { app("reality_short_id", *patch.RealityShortID) }
	if patch.RealityHandshakeServer != nil { app("reality_handshake_server", *patch.RealityHandshakeServer) }
	if patch.RealityHandshakePort != nil   { app("reality_handshake_port", *patch.RealityHandshakePort) }
	if patch.TransportPath != nil          { app("transport_path", *patch.TransportPath) }
	if patch.TransportHost != nil          { app("transport_host", *patch.TransportHost) }
	if patch.AlterID != nil               { app("alter_id", *patch.AlterID) }
	if patch.SSMethod != nil               { app("ss_method", *patch.SSMethod) }
	if patch.ExtraJSON != nil              { app("extra_json", *patch.ExtraJSON) }

	if len(set) == 0 {
		return nil
	}
	set = append(set, "updated_at=?")
	args = append(args, s.now())
	args = append(args, id)
	q := s.DB.Rebind(fmt.Sprintf("UPDATE singbox_inbounds SET %s WHERE id=?", strings.Join(set, ", ")))
	_, err := s.DB.ExecContext(ctx, q, args...)
	return err
}

// Delete removes the inbound row. FK ON DELETE RESTRICT (upstream_inbound_id self-ref)
// causes an error if any relay inbound references this row.
func (s *InboundStore) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM singbox_inbounds WHERE id=$1`, id)
	return err
}
