package telemetrysvc

import (
	"context"

	"github.com/hg-claw/Shepherd/internal/agentapi"
)

// WriteTrafficBatch inserts a slice of XrayTrafficSample rows into xray_traffic_raw
// within a single transaction. Empty slice is a no-op.
func (i *Ingest) WriteTrafficBatch(ctx context.Context, serverID int64, samples []agentapi.XrayTrafficSample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := i.DB.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, `
		INSERT INTO xray_traffic_raw (server_id, tag, kind, ts, bytes_up, bytes_down)
		VALUES ($1, $2, $3, $4, $5, $6)`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, s := range samples {
		if _, err := stmt.ExecContext(ctx, serverID, s.Tag, s.Kind, s.TS.UTC(), s.BytesUp, s.BytesDown); err != nil {
			return err
		}
	}
	return tx.Commit()
}
