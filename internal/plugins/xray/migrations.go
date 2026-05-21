package xray

import (
	"embed"
	"fmt"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migFS embed.FS

// Migrations returns the ordered list of xray plugin migrations for the given
// driver. Exported so tests in other packages can apply migrations in a test DB.
func Migrations(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }

func loadMigrations(driver shepdb.Driver) []plugins.Migration {
	names := []string{
		"0001_xray.up.sql",
		"0002_topology.up.sql",
		"0003_multi_inbound.up.sql",
		"0004_traffic.up.sql",
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
			panic(fmt.Sprintf("xray: missing migration %s: %v", path, err))
		}
		out = append(out, plugins.Migration{Name: n[:len(n)-len(".up.sql")], SQL: string(b)})
	}
	return out
}
