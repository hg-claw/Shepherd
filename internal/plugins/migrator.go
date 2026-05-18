package plugins

import (
	"context"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"
)

// RunPluginMigrations applies any of migs that haven't already been
// recorded in plugin_migrations for the given pluginID. Each migration
// runs in its own transaction; on failure later migrations are skipped.
func RunPluginMigrations(ctx context.Context, db *sqlx.DB, pluginID string, migs []Migration) error {
	for _, m := range migs {
		var n int
		err := db.GetContext(ctx, &n,
			"SELECT COUNT(*) FROM plugin_migrations WHERE plugin_id=? AND name=?", pluginID, m.Name)
		if err != nil {
			return fmt.Errorf("plugin %s migration %s: lookup: %w", pluginID, m.Name, err)
		}
		if n > 0 {
			continue
		}
		tx, err := db.BeginTxx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, m.SQL); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("plugin %s migration %s: exec: %w", pluginID, m.Name, err)
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO plugin_migrations(plugin_id, name, applied_at) VALUES (?, ?, ?)",
			pluginID, m.Name, time.Now().UTC()); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
