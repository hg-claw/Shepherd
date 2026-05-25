package serversvc

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

var ErrNotFound = errors.New("server not found")

type Server struct {
	ID           int64          `db:"id"                  json:"id"`
	Name         string         `db:"name"                json:"name"`
	PublicAlias  sql.NullString `db:"public_alias"        json:"public_alias"`
	PublicGroup  sql.NullString `db:"public_group"        json:"public_group"`
	CountryCode  sql.NullString `db:"country_code"        json:"country_code"`
	ShowOnPublic bool           `db:"show_on_public"      json:"show_on_public"`

	SSHHost          sql.NullString `db:"ssh_host"            json:"ssh_host"`
	SSHPort          int            `db:"ssh_port"            json:"ssh_port"`
	SSHUser          sql.NullString `db:"ssh_user"            json:"ssh_user"`
	InstallStage     string         `db:"install_stage"       json:"install_stage"`
	InstallLog       string         `db:"install_log"         json:"install_log"`
	InstallError     sql.NullString `db:"install_error"       json:"install_error"`
	InstallStartedAt sql.NullTime   `db:"install_started_at"  json:"install_started_at"`

	AgentVersion     sql.NullString `db:"agent_version"       json:"agent_version"`
	AgentOS          sql.NullString `db:"agent_os"            json:"agent_os"`
	AgentArch        sql.NullString `db:"agent_arch"          json:"agent_arch"`
	AgentKernel      sql.NullString `db:"agent_kernel"        json:"agent_kernel"`
	AgentLastSeen    sql.NullTime   `db:"agent_last_seen"     json:"agent_last_seen"`
	AgentFingerprint sql.NullString `db:"agent_fingerprint"   json:"agent_fingerprint"`

	CreatedAt time.Time `db:"created_at"          json:"created_at"`
}

const selectAllCols = `id, name, public_alias, public_group, country_code, show_on_public,
	ssh_host, ssh_port, ssh_user, install_stage, install_log, install_error, install_started_at,
	agent_version, agent_os, agent_arch, agent_kernel, agent_last_seen, agent_fingerprint, created_at`

type Service struct {
	DB *sqlx.DB
}

type CreateInput struct {
	Name         string
	PublicAlias  string
	PublicGroup  string
	CountryCode  string
	ShowOnPublic bool
	SSHHost      string
	SSHPort      int
	SSHUser      string
}

func (s *Service) Create(ctx context.Context, in CreateInput) (*Server, error) {
	if in.SSHPort == 0 {
		in.SSHPort = 22
	}
	// RETURNING works on both SQLite 3.35+ (modernc/mattn) and Postgres.
	// LastInsertId is unsupported by lib/pq and would return 0, making the
	// subsequent Get(0) fail with ErrNotFound — surfaced to the UI as a
	// confusing "server not found" right after a successful create.
	var id int64
	err := s.DB.QueryRowxContext(ctx, `INSERT INTO servers
		(name, public_alias, public_group, country_code, show_on_public,
		 ssh_host, ssh_port, ssh_user, install_stage, install_log)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending','')
		RETURNING id`,
		in.Name, nullable(in.PublicAlias), nullable(in.PublicGroup), nullable(in.CountryCode),
		in.ShowOnPublic, nullable(in.SSHHost), in.SSHPort, nullable(in.SSHUser),
	).Scan(&id)
	if err != nil {
		return nil, err
	}
	return s.Get(ctx, id)
}

func (s *Service) Get(ctx context.Context, id int64) (*Server, error) {
	var srv Server
	err := s.DB.GetContext(ctx, &srv, "SELECT "+selectAllCols+" FROM servers WHERE id=$1", id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &srv, err
}

func (s *Service) List(ctx context.Context) ([]*Server, error) {
	var out []*Server
	err := s.DB.SelectContext(ctx, &out, "SELECT "+selectAllCols+" FROM servers ORDER BY id")
	return out, err
}

type PatchInput struct {
	Name         *string
	PublicAlias  *string
	PublicGroup  *string
	CountryCode  *string
	ShowOnPublic *bool
	SSHHost      *string
}

func (s *Service) Patch(ctx context.Context, id int64, in PatchInput) (*Server, error) {
	if in.Name != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET name=$1 WHERE id=$2", *in.Name, id); err != nil {
			return nil, err
		}
	}
	if in.PublicAlias != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET public_alias=$1 WHERE id=$2", nullable(*in.PublicAlias), id); err != nil {
			return nil, err
		}
	}
	if in.PublicGroup != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET public_group=$1 WHERE id=$2", nullable(*in.PublicGroup), id); err != nil {
			return nil, err
		}
	}
	if in.CountryCode != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET country_code=$1 WHERE id=$2", nullable(*in.CountryCode), id); err != nil {
			return nil, err
		}
	}
	if in.ShowOnPublic != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET show_on_public=$1 WHERE id=$2", *in.ShowOnPublic, id); err != nil {
			return nil, err
		}
	}
	if in.SSHHost != nil {
		if _, err := s.DB.ExecContext(ctx, "UPDATE servers SET ssh_host=$1 WHERE id=$2", nullable(*in.SSHHost), id); err != nil {
			return nil, err
		}
	}
	return s.Get(ctx, id)
}

// UpdateSSHTarget persists the SSH host/user/port for a server. Used by
// the re-install flow so a corrected user/host (e.g. the original install
// targeted the wrong account) sticks for later SSH-based operations
// (repair, update-agent) instead of silently reverting to the stale row.
func (s *Service) UpdateSSHTarget(ctx context.Context, id int64, host, user string, port int) error {
	if port == 0 {
		port = 22
	}
	_, err := s.DB.ExecContext(ctx,
		"UPDATE servers SET ssh_host=$1, ssh_user=$2, ssh_port=$3 WHERE id=$4",
		nullable(host), nullable(user), port, id)
	return err
}

func (s *Service) Delete(ctx context.Context, id int64) error {
	res, err := s.DB.ExecContext(ctx, "DELETE FROM servers WHERE id=$1", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func nullable(s string) sql.NullString {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

// appendInstallLog atomically appends a line + "\n" to servers.install_log.
// Both SQLite and Postgres support COALESCE + concat with `||`.
func (s *Service) appendInstallLog(ctx context.Context, id int64, line string) {
	_, _ = s.DB.ExecContext(ctx,
		`UPDATE servers SET install_log = install_log || $1 WHERE id=$2`, line+"\n", id)
}

// SetInstallStage updates install_stage, optionally clearing install_error.
func (s *Service) SetInstallStage(ctx context.Context, id int64, stage string, errMsg *string) error {
	if errMsg == nil {
		_, err := s.DB.ExecContext(ctx, "UPDATE servers SET install_stage=$1, install_error=NULL WHERE id=$2", stage, id)
		return err
	}
	_, err := s.DB.ExecContext(ctx, "UPDATE servers SET install_stage=$1, install_error=$2 WHERE id=$3", stage, *errMsg, id)
	return err
}
