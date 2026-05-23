package telemetrysvc

import (
	"context"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// WriteNetqualityBatch inserts samples into netquality_samples_raw and
// clears the host's last_error on the way through. One transaction per
// batch keeps the operation atomic — a half-applied batch on connection
// drop would skew the next minute's rollup average.
//
// Targets that no longer exist in the catalog (admin deleted them
// mid-flight) cause an FK violation on insert; we let the transaction
// fail in that case so the rest of the batch gets retried by the agent
// on the next tick rather than committing partial data.
func (i *Ingest) WriteNetqualityBatch(ctx context.Context, serverID int64, samples []agentapi.NetqualitySample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := i.DB.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO netquality_samples_raw
		  (server_id, target_id, ts, rtt_avg_ms, rtt_min_ms, rtt_max_ms, jitter_ms, loss_pct, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, s := range samples {
		if _, err := stmt.ExecContext(ctx,
			serverID, s.TargetID, s.TS.UTC(),
			s.RTTAvgMs, s.RTTMinMs, s.RTTMaxMs, s.JitterMs,
			s.LossPct, s.Status,
		); err != nil {
			return err
		}
	}

	// Clear last_error on the host row so the admin UI shows the host
	// as healthy as soon as the next batch lands. updated_at bumps too
	// so "last seen sampling" is queryable without joining the raw
	// table.
	if _, err := tx.ExecContext(ctx, `
		UPDATE netquality_hosts SET last_error = NULL, updated_at = $1
		 WHERE server_id = $2`,
		time.Now().UTC(), serverID); err != nil {
		return err
	}
	return tx.Commit()
}
