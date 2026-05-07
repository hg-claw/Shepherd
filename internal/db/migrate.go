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

// Migrate runs all per-dialect migrations under migrations/<driver>/ via golang-migrate.
// Tracks applied versions in the schema_migrations table that golang-migrate creates.
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
	defer func() { _ = src.Close() }()

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
