package plugins

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/jmoiron/sqlx"
)

// MinAgentVersionForFetch is the agent version that first supports the
// TypeFileFetch frame (agent-direct binary download). Deploys against
// older agents are rejected with a clear "upgrade agent" error so the
// operator doesn't waste a deploy cycle on a silent no-op.
//
// Bump this when the on-wire contract changes again.
const MinAgentVersionForFetch = "0.9.0"

// RequireAgentVersionAtLeast returns nil when the agent attached to
// serverID is running at least minVersion. Allows "dev" / "" / unparseable
// versions to pass — those are developer iterations that shouldn't be
// blocked by a version check the dev knows is wrong.
//
// Reads servers.agent_version, which the heartbeat handler updates on
// every connect, so the DB is authoritative for "what's actually
// running right now" within ~60s of an upgrade.
func RequireAgentVersionAtLeast(ctx context.Context, db *sqlx.DB, serverID int64, minVersion string) error {
	var v sql.NullString
	err := db.QueryRowxContext(ctx,
		"SELECT agent_version FROM servers WHERE id=$1", serverID).Scan(&v)
	if err != nil {
		return fmt.Errorf("read agent_version: %w", err)
	}
	current := strings.TrimSpace(v.String)
	if current == "" || current == "dev" {
		return nil
	}
	cmp, ok := compareSemver(current, minVersion)
	if !ok {
		// Unparseable — treat as a dev build, don't block. The deploy will
		// fail anyway if the agent doesn't grok the frame, just slower.
		return nil
	}
	if cmp < 0 {
		return errors.New("agent running v" + current + " is too old for this deploy; upgrade to v" + minVersion + "+ first (re-run install-agent.sh)")
	}
	return nil
}

// compareSemver returns -1/0/1 like strings.Compare but for "X.Y.Z" /
// "X.Y.Z-suffix" version strings. Suffixes are ignored. The ok flag is
// false when either string can't be split into three integer parts.
func compareSemver(a, b string) (int, bool) {
	aMaj, aMin, aPat, ok := parseSemver(a)
	if !ok {
		return 0, false
	}
	bMaj, bMin, bPat, ok := parseSemver(b)
	if !ok {
		return 0, false
	}
	switch {
	case aMaj != bMaj:
		return sign(aMaj - bMaj), true
	case aMin != bMin:
		return sign(aMin - bMin), true
	case aPat != bPat:
		return sign(aPat - bPat), true
	default:
		return 0, true
	}
}

func parseSemver(s string) (int, int, int, bool) {
	s = strings.TrimPrefix(s, "v")
	// Drop "-suffix" (e.g. "1.0.0-rc1").
	if i := strings.IndexByte(s, '-'); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	maj, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, 0, false
	}
	min, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, 0, false
	}
	pat, err := strconv.Atoi(parts[2])
	if err != nil {
		return 0, 0, 0, false
	}
	return maj, min, pat, true
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	default:
		return 0
	}
}
