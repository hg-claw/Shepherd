package singbox

import (
	"embed"
	"fmt"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migFS embed.FS

// Migrations returns the ordered list of singbox plugin migrations for the given
// driver. Exported so tests in other packages can apply migrations in a test DB.
func Migrations(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }

func loadMigrations(driver shepdb.Driver) []plugins.Migration {
	names := []string{
		"0001_singbox_inbounds.up.sql",
		"0002_singbox_binaries.up.sql",
		"0003_singbox_traffic.up.sql",
		"0004_singbox_certificates.up.sql",
		"0005_singbox_cert_challenge_type.up.sql",
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
			panic(fmt.Sprintf("singbox: missing migration %s: %v", path, err))
		}
		out = append(out, plugins.Migration{Name: n[:len(n)-len(".up.sql")], SQL: string(b)})
	}
	return out
}
