package netquality

import (
	"context"
	"time"

	"github.com/jmoiron/sqlx"
)

// ISPSummary is one ISP's freshness number for a server, surfaced on the
// public wall when the plugin is enabled for that server. RTT/Loss are
// averages over the last LookbackSeconds window across every enabled
// target in that ISP bucket — gives a "this server feels X ms from
// $ISP right now" headline without leaking the full target list.
type ISPSummary struct {
	ISP     string  `json:"isp"`      // telecom|unicom|mobile|overseas
	RTTAvgMs float64 `json:"rtt_avg_ms"`
	LossPct  float64 `json:"loss_pct"`
}

// LookbackSeconds is how far back the per-ISP average reaches. 30 minutes
// keeps the surfaced number "recent" without being so jumpy that a
// single bad probe spikes the public view.
const LookbackSeconds = 30 * 60

// LatestPerISP returns one row per ISP for which we have a recent
// sample. Returns an empty (nil, nil) slice — never an error — when the
// plugin's tables don't exist yet (plugin never enabled). The caller is
// the public wall handler and should not 500 because the wall doesn't
// know about us.
func LatestPerISP(ctx context.Context, db *sqlx.DB, serverID int64) []ISPSummary {
	// First: cheap "are we configured?" check. A server without
	// netquality_hosts.enabled=true has nothing to show; the broader
	// SELECT below would still work but burns a query for nothing.
	var enabled bool
	if err := db.GetContext(ctx, &enabled,
		`SELECT enabled FROM netquality_hosts WHERE server_id = $1`, serverID); err != nil {
		return nil // no row, or table missing — both mean "off"
	}
	if !enabled {
		return nil
	}

	// We aggregate over the RAW table so the public number reflects the
	// freshest data — minute rollups lag by up to ~1 min. Filter on UTC
	// epoch math computed by the driver to avoid embedding portable
	// time literals in SQL.
	cutoff := time.Now().UTC().Add(-1 * time.Duration(LookbackSeconds) * time.Second)

	var rows []ISPSummary
	err := db.SelectContext(ctx, &rows, `
		SELECT t.isp AS isp,
		       AVG(s.rtt_avg_ms) AS rtt_avg_ms,
		       AVG(s.loss_pct)   AS loss_pct
		  FROM netquality_targets t
		  JOIN netquality_samples_raw s ON s.target_id = t.id
		 WHERE s.server_id = $1
		   AND t.enabled = true
		   AND s.ts > $2
		   AND s.status = 'ok'
		 GROUP BY t.isp
		 ORDER BY t.isp`,
		serverID, cutoff)
	if err != nil {
		return nil
	}
	return rows
}
