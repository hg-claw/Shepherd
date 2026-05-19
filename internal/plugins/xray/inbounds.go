package xray

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

type Inbound struct {
	ID                int64     `db:"id"`
	ServerID          int64     `db:"server_id"`
	Tag               string    `db:"tag"`
	Port              int       `db:"port"`
	Role              string    `db:"role"`
	Protocol          string    `db:"protocol"`
	UUID              string    `db:"uuid"`
	SNI               string    `db:"sni"`
	PublicKey         string    `db:"public_key"`
	PrivateKey        string    `db:"private_key"`
	ShortID           string    `db:"short_id"`
	WSPath            string    `db:"ws_path"`
	SSMethod          string    `db:"ss_method"`
	SSPassword        string    `db:"ss_password"`
	UpstreamInboundID *int64    `db:"upstream_inbound_id"`
	CreatedAt         time.Time `db:"created_at"`
	UpdatedAt         time.Time `db:"updated_at"`
}

// InboundView extends Inbound with JOIN fields used when the row is rendered
// for the UI or for config assembly. Upstream fields are populated only for
// relay rows (NULL otherwise).
type InboundView struct {
	Inbound
	ServerName         string         `db:"server_name"`
	UpstreamTag        sql.NullString `db:"upstream_tag"`
	UpstreamPort       sql.NullInt64  `db:"upstream_port"`
	UpstreamServerID   sql.NullInt64  `db:"upstream_server_id"`
	UpstreamServerName sql.NullString `db:"upstream_server_name"`
	UpstreamSNI        sql.NullString `db:"upstream_sni"`
	UpstreamUUID       sql.NullString `db:"upstream_uuid"`
	UpstreamPublicKey  sql.NullString `db:"upstream_public_key"`
	UpstreamShortID    sql.NullString `db:"upstream_short_id"`
	UpstreamAddress    sql.NullString `db:"upstream_address"`
}

// InboundPatch is the set of mutable fields for Update. nil pointer = leave unchanged.
// role / server_id / tag / upstream_inbound_id / protocol are NOT in this struct
// because they are immutable post-create.
type InboundPatch struct {
	Port       *int
	UUID       *string
	SNI        *string
	PublicKey  *string
	PrivateKey *string
	ShortID    *string
	WSPath     *string
	SSMethod   *string
	SSPassword *string
}

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

func (s *InboundStore) GenerateTag(role string) string {
	var buf [4]byte
	_, _ = rand.Read(buf[:])
	return role + "-" + hex.EncodeToString(buf[:])
}

func (s *InboundStore) Insert(ctx context.Context, in Inbound) (int64, error) {
	if in.Tag == "" {
		in.Tag = s.GenerateTag(in.Role)
	}
	now := s.now()
	res, err := s.DB.ExecContext(ctx, `
		INSERT INTO xray_inbounds (
		  server_id, tag, port, role, protocol,
		  uuid, sni, public_key, private_key, short_id,
		  ws_path, ss_method, ss_password,
		  upstream_inbound_id, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		in.ServerID, in.Tag, in.Port, in.Role, in.Protocol,
		in.UUID, in.SNI, in.PublicKey, in.PrivateKey, in.ShortID,
		in.WSPath, in.SSMethod, in.SSPassword,
		in.UpstreamInboundID, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *InboundStore) GetByID(ctx context.Context, id int64) (Inbound, error) {
	var row Inbound
	err := s.DB.GetContext(ctx, &row,
		`SELECT * FROM xray_inbounds WHERE id=?`, id)
	return row, err
}

func (s *InboundStore) ListByServer(ctx context.Context, serverID int64) ([]Inbound, error) {
	rows := []Inbound{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM xray_inbounds WHERE server_id=? ORDER BY id`, serverID)
	return rows, err
}

func (s *InboundStore) ListAllWithUpstream(ctx context.Context) ([]InboundView, error) {
	rows := []InboundView{}
	err := s.DB.SelectContext(ctx, &rows, `
		SELECT
		  i.id, i.server_id, i.tag, i.port, i.role, i.protocol,
		  i.uuid, i.sni, i.public_key, i.private_key, i.short_id,
		  i.ws_path, i.ss_method, i.ss_password,
		  i.upstream_inbound_id, i.created_at, i.updated_at,
		  s.name AS server_name,
		  u.tag AS upstream_tag,
		  u.port AS upstream_port,
		  u.server_id AS upstream_server_id,
		  us.name AS upstream_server_name,
		  u.sni AS upstream_sni,
		  u.uuid AS upstream_uuid,
		  u.public_key AS upstream_public_key,
		  u.short_id AS upstream_short_id,
		  us.ssh_host AS upstream_address
		FROM xray_inbounds i
		JOIN servers s ON s.id = i.server_id
		LEFT JOIN xray_inbounds u ON u.id = i.upstream_inbound_id
		LEFT JOIN servers us ON us.id = u.server_id
		ORDER BY i.server_id, i.id`)
	return rows, err
}

func (s *InboundStore) ListByUpstream(ctx context.Context, landingID int64) ([]Inbound, error) {
	rows := []Inbound{}
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT * FROM xray_inbounds WHERE upstream_inbound_id=? ORDER BY id`, landingID)
	return rows, err
}

func (s *InboundStore) Update(ctx context.Context, id int64, patch InboundPatch) error {
	set := []string{}
	args := []any{}
	if patch.Port != nil {
		set = append(set, "port=?")
		args = append(args, *patch.Port)
	}
	if patch.UUID != nil {
		set = append(set, "uuid=?")
		args = append(args, *patch.UUID)
	}
	if patch.SNI != nil {
		set = append(set, "sni=?")
		args = append(args, *patch.SNI)
	}
	if patch.PublicKey != nil {
		set = append(set, "public_key=?")
		args = append(args, *patch.PublicKey)
	}
	if patch.PrivateKey != nil {
		set = append(set, "private_key=?")
		args = append(args, *patch.PrivateKey)
	}
	if patch.ShortID != nil {
		set = append(set, "short_id=?")
		args = append(args, *patch.ShortID)
	}
	if patch.WSPath != nil {
		set = append(set, "ws_path=?")
		args = append(args, *patch.WSPath)
	}
	if patch.SSMethod != nil {
		set = append(set, "ss_method=?")
		args = append(args, *patch.SSMethod)
	}
	if patch.SSPassword != nil {
		set = append(set, "ss_password=?")
		args = append(args, *patch.SSPassword)
	}
	if len(set) == 0 {
		return nil
	}
	set = append(set, "updated_at=?")
	args = append(args, s.now())
	args = append(args, id)
	q := fmt.Sprintf("UPDATE xray_inbounds SET %s WHERE id=?", strings.Join(set, ", "))
	_, err := s.DB.ExecContext(ctx, q, args...)
	return err
}

func (s *InboundStore) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM xray_inbounds WHERE id=?`, id)
	return err
}
