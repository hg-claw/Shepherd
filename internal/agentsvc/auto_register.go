package agentsvc

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
)

var ErrAutoRegisterDisabled = errors.New("auto-register disabled")
var ErrBadAutoRecoverKey = errors.New("bad auto recover key")

// AutoRegister either rotates the machine token of an existing server
// (matched by fingerprint) or creates a new server row and mints a fresh token.
func (s *Service) AutoRegister(ctx context.Context, key, fingerprint, hostname, osName, arch, kernel, agentVersion string) (string, int64, error) {
	if s.AutoRecoverKey == "" {
		return "", 0, ErrAutoRegisterDisabled
	}
	if subtle.ConstantTimeCompare([]byte(key), []byte(s.AutoRecoverKey)) != 1 {
		return "", 0, ErrBadAutoRecoverKey
	}

	tx, err := s.DB.BeginTxx(ctx, nil)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = tx.Rollback() }()

	var serverID int64
	err = tx.QueryRowxContext(ctx,
		"SELECT id FROM servers WHERE agent_fingerprint=$1", fingerprint).Scan(&serverID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// Create new server. Use hostname for name; fingerprint stays unique.
		res, err := tx.ExecContext(ctx, `INSERT INTO servers
			(name, agent_fingerprint, agent_os, agent_arch, agent_kernel, agent_version, install_stage)
			VALUES ($1, $2, $3, $4, $5, $6, 'done')`,
			hostname, fingerprint, osName, arch, kernel, agentVersion)
		if err != nil {
			return "", 0, err
		}
		serverID, _ = res.LastInsertId()
	case err != nil:
		return "", 0, err
	default:
		// Existing server — refresh metadata.
		if _, err := tx.ExecContext(ctx, `UPDATE servers SET
				agent_os=$1, agent_arch=$2, agent_kernel=$3, agent_version=$4
				WHERE id=$5`, osName, arch, kernel, agentVersion, serverID); err != nil {
			return "", 0, err
		}
		// Rotate: drop existing tokens for this server.
		if _, err := tx.ExecContext(ctx, "DELETE FROM machine_tokens WHERE server_id=$1", serverID); err != nil {
			return "", 0, err
		}
	}

	machine, err := randomToken(32)
	if err != nil {
		return "", 0, err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO machine_tokens(token, server_id, rotated_at) VALUES ($1,$2,CURRENT_TIMESTAMP)",
		machine, serverID); err != nil {
		return "", 0, err
	}
	if err := tx.Commit(); err != nil {
		return "", 0, err
	}
	return machine, serverID, nil
}
