package singbox

import (
	"embed"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

//go:embed migrations/*.sql
var migFS embed.FS

// Migrations returns the ordered list of singbox plugin migrations.
func Migrations() []plugins.Migration { return loadMigrations() }

func loadMigrations() []plugins.Migration {
	names := []string{}
	out := make([]plugins.Migration, 0, len(names))
	for _, n := range names {
		b, err := migFS.ReadFile("migrations/" + n)
		if err != nil {
			panic("singbox: missing migration " + n + ": " + err.Error())
		}
		out = append(out, plugins.Migration{Name: n[:len(n)-len(".up.sql")], SQL: string(b)})
	}
	return out
}
