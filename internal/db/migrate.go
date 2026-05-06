package db

import (
	"embed"
	"errors"
	"fmt"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database"
	migratePostgres "github.com/golang-migrate/migrate/v4/database/postgres"
	migrateSQLite "github.com/golang-migrate/migrate/v4/database/sqlite3"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"github.com/jmoiron/sqlx"
)

// 0000_placeholder.* are placeholders so go:embed has matches before 0001_init lands in Task 3;
// delete them when the first real migration is added.
//
//go:embed migrations/sqlite/*.sql migrations/postgres/*.sql
var migrationsFS embed.FS

func Migrate(d *sqlx.DB, driver Driver) error {
	subdir := "migrations/sqlite"
	if driver == DriverPostgres {
		subdir = "migrations/postgres"
	}
	src, err := iofs.New(migrationsFS, subdir)
	if err != nil {
		return err
	}
	defer src.Close()

	var dbDriver database.Driver
	switch driver {
	case DriverSQLite:
		dbDriver, err = migrateSQLite.WithInstance(d.DB, &migrateSQLite.Config{})
	case DriverPostgres:
		dbDriver, err = migratePostgres.WithInstance(d.DB, &migratePostgres.Config{})
	default:
		return fmt.Errorf("unknown driver %q", driver)
	}
	if err != nil {
		return err
	}

	m, err := migrate.NewWithInstance("iofs", src, string(driver), dbDriver)
	if err != nil {
		return err
	}
	if err := m.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return err
	}
	return nil
}
