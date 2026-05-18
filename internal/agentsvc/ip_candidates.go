package agentsvc

import (
	"context"
	"database/sql"
	"time"

	"github.com/jmoiron/sqlx"
)

// IPCandidate is the internal (service-layer) representation of a candidate address.
type IPCandidate struct {
	Addr   string
	Kind   string
	Source string
}

var kindRank = map[string]int{"public": 0, "private": 1, "cgnat": 2, "vpn": 3}

// PickBest returns the highest-priority candidate's address, or "" if none.
func PickBest(cands []IPCandidate) string {
	best := -1
	for i, c := range cands {
		r, ok := kindRank[c.Kind]
		if !ok {
			r = 99
		}
		if best == -1 {
			best = i
			continue
		}
		curR, ok2 := kindRank[cands[best].Kind]
		if !ok2 {
			curR = 99
		}
		if r < curR {
			best = i
		}
	}
	if best == -1 {
		return ""
	}
	return cands[best].Addr
}

// SaveCandidates upserts all candidates into server_ip_candidates.
func SaveCandidates(ctx context.Context, db *sqlx.DB, serverID int64, cands []IPCandidate) error {
	now := time.Now().UTC()
	for _, c := range cands {
		if c.Addr == "" {
			continue
		}
		if _, err := db.ExecContext(ctx,
			`INSERT INTO server_ip_candidates(server_id, addr, kind, source, detected_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(server_id, addr) DO UPDATE SET
			   kind=excluded.kind, source=excluded.source, detected_at=excluded.detected_at`,
			serverID, c.Addr, c.Kind, c.Source, now); err != nil {
			return err
		}
	}
	return nil
}

// ApplyBestSSHHost updates servers.ssh_host to PickBest(cands) only when the
// existing value is empty / null. We never override an admin-chosen address.
func ApplyBestSSHHost(ctx context.Context, db *sqlx.DB, serverID int64, cands []IPCandidate) error {
	best := PickBest(cands)
	if best == "" {
		return nil
	}
	var current sql.NullString
	if err := db.GetContext(ctx, &current, "SELECT ssh_host FROM servers WHERE id=?", serverID); err != nil {
		return err
	}
	if current.Valid && current.String != "" {
		return nil
	}
	_, err := db.ExecContext(ctx, "UPDATE servers SET ssh_host=? WHERE id=?", best, serverID)
	return err
}

// IPCandidateRow is a database row from server_ip_candidates.
type IPCandidateRow struct {
	ServerID   int64     `db:"server_id"   json:"server_id"`
	Addr       string    `db:"addr"        json:"addr"`
	Kind       string    `db:"kind"        json:"kind"`
	Source     string    `db:"source"      json:"source"`
	DetectedAt time.Time `db:"detected_at" json:"detected_at"`
}

// ListIPCandidates returns all candidates for a server, ordered by addr.
func (s *Service) ListIPCandidates(ctx context.Context, serverID int64) ([]IPCandidateRow, error) {
	var rows []IPCandidateRow
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT server_id, addr, kind, source, detected_at
		   FROM server_ip_candidates
		  WHERE server_id=?
		  ORDER BY addr`,
		serverID)
	if err != nil {
		return nil, err
	}
	return rows, nil
}
