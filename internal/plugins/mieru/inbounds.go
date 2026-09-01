package mieru

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"time"

	"github.com/jmoiron/sqlx"
)

type Inbound struct {
	ID            int64     `db:"id"`
	ServerID      int64     `db:"server_id"`
	Tag           string    `db:"tag"`
	Alias         string    `db:"alias"`
	Port          int       `db:"port"`
	Protocol      string    `db:"protocol"`
	Username      string    `db:"username"`
	Password      string    `db:"password"`
	MTU           int       `db:"mtu"`
	Multiplexing  string    `db:"multiplexing"`
	HandshakeMode string    `db:"handshake_mode"`
	CreatedAt     time.Time `db:"created_at"`
	UpdatedAt     time.Time `db:"updated_at"`
}

type InboundView struct {
	Inbound
	ServerName string         `db:"server_name"`
	ServerHost sql.NullString `db:"server_host"`
}

type InboundPatch struct {
	Port          *int
	Alias         *string
	Username      *string
	Password      *string
	Protocol      *string
	MTU           *int
	Multiplexing  *string
	HandshakeMode *string
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

func (s *InboundStore) GenerateTag() string {
	var buf [4]byte
	_, _ = rand.Read(buf[:])
	return "landing-" + hex.EncodeToString(buf[:])
}

func (s *InboundStore) Insert(ctx context.Context, in Inbound) (int64, error) {
	if in.Tag == "" {
		in.Tag = s.GenerateTag()
	}
	if in.Protocol == "" {
		in.Protocol = "TCP"
	}
	if in.MTU == 0 {
		in.MTU = 1400
	}
	if in.Multiplexing == "" {
		in.Multiplexing = "MULTIPLEXING_OFF"
	}
	if in.HandshakeMode == "" {
		in.HandshakeMode = "HANDSHAKE_NO_WAIT"
	}
	now := s.now()
	var id int64
	if err := s.DB.QueryRowxContext(ctx, `
		INSERT INTO mieru_inbounds (
		  server_id, tag, alias, port, protocol, username, password,
		  mtu, multiplexing, handshake_mode, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
		RETURNING id`,
		in.ServerID, in.Tag, in.Alias, in.Port, in.Protocol, in.Username, in.Password,
		in.MTU, in.Multiplexing, in.HandshakeMode, now, now).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *InboundStore) GetByID(ctx context.Context, id int64) (Inbound, error) {
	var row Inbound
	err := s.DB.GetContext(ctx, &row, `SELECT * FROM mieru_inbounds WHERE id=$1`, id)
	return row, err
}

func (s *InboundStore) ListByServer(ctx context.Context, serverID int64) ([]Inbound, error) {
	var rows []Inbound
	err := s.DB.SelectContext(ctx, &rows, `SELECT * FROM mieru_inbounds WHERE server_id=$1 ORDER BY id`, serverID)
	return rows, err
}

func (s *InboundStore) ListAll(ctx context.Context) ([]InboundView, error) {
	var rows []InboundView
	err := s.DB.SelectContext(ctx, &rows, `
		SELECT i.*, s.name AS server_name, s.ssh_host AS server_host
		  FROM mieru_inbounds i
		  JOIN servers s ON s.id=i.server_id
		 ORDER BY i.id`)
	return rows, err
}

func (s *InboundStore) Update(ctx context.Context, id int64, patch InboundPatch) error {
	row, err := s.GetByID(ctx, id)
	if err != nil {
		return err
	}
	if patch.Port != nil {
		row.Port = *patch.Port
	}
	if patch.Alias != nil {
		row.Alias = *patch.Alias
	}
	if patch.Username != nil {
		row.Username = *patch.Username
	}
	if patch.Password != nil {
		row.Password = *patch.Password
	}
	if patch.Protocol != nil {
		row.Protocol = *patch.Protocol
	}
	if patch.MTU != nil {
		row.MTU = *patch.MTU
	}
	if patch.Multiplexing != nil {
		row.Multiplexing = *patch.Multiplexing
	}
	if patch.HandshakeMode != nil {
		row.HandshakeMode = *patch.HandshakeMode
	}
	_, err = s.DB.ExecContext(ctx, `
		UPDATE mieru_inbounds SET
		  alias=$1, port=$2, protocol=$3, username=$4, password=$5,
		  mtu=$6, multiplexing=$7, handshake_mode=$8, updated_at=$9
		WHERE id=$10`,
		row.Alias, row.Port, row.Protocol, row.Username, row.Password,
		row.MTU, row.Multiplexing, row.HandshakeMode, s.now(), id)
	return err
}

func (s *InboundStore) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM mieru_inbounds WHERE id=$1`, id)
	return err
}
