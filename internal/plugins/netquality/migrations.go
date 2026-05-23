package netquality

import (
	"embed"
	"fmt"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migFS embed.FS

// Migrations is the package-level form mirrored by every plugin — lets
// telemetrysvc / ingest tests apply our schema without instantiating
// the Plugin struct first.
func Migrations(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }

// loadMigrations returns the per-driver migration set. Shape mirrors the
// other plugins (cloudflare/singbox/xray) so the same migrator can pick
// them up unchanged.
func loadMigrations(driver shepdb.Driver) []plugins.Migration {
	names := []string{
		"0001_netquality.up.sql",
		"0002_host_targets.up.sql",
	}
	subdir := "sqlite"
	if driver == shepdb.DriverPostgres {
		subdir = "postgres"
	}
	out := make([]plugins.Migration, 0, len(names))
	for _, n := range names {
		path := "migrations/" + subdir + "/" + n
		b, err := migFS.ReadFile(path)
		if err != nil {
			panic(fmt.Sprintf("netquality: missing migration %s: %v", path, err))
		}
		out = append(out, plugins.Migration{Name: n[:len(n)-len(".up.sql")], SQL: string(b)})
	}
	return out
}
