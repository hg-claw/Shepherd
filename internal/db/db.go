package db

import (
	"context"
	"errors"
	"fmt"

	"github.com/jmoiron/sqlx"
	_ "github.com/lib/pq"
	_ "github.com/mattn/go-sqlite3"
)

type Driver string

const (
	DriverSQLite   Driver = "sqlite"
	DriverPostgres Driver = "postgres"
)

type Config struct {
	Driver Driver
	DSN    string
}

var ErrInvalidConfig = errors.New("invalid db config")

func Open(ctx context.Context, cfg Config) (*sqlx.DB, error) {
	var goDriver string
	switch cfg.Driver {
	case DriverSQLite:
		goDriver = "sqlite3"
	case DriverPostgres:
		goDriver = "postgres"
	default:
		return nil, fmt.Errorf("%w: unknown driver %q", ErrInvalidConfig, cfg.Driver)
	}
	d, err := sqlx.Open(goDriver, cfg.DSN)
	if err != nil {
		return nil, err
	}
	if err := d.PingContext(ctx); err != nil {
		_ = d.Close()
		return nil, err
	}
	if cfg.Driver == DriverSQLite {
		if _, err := d.Exec("PRAGMA journal_mode=WAL"); err != nil {
			return nil, err
		}
		if _, err := d.Exec("PRAGMA foreign_keys=ON"); err != nil {
			return nil, err
		}
	}
	return d, nil
}
