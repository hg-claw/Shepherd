package telemetrysvc

import "github.com/jmoiron/sqlx"

// minuteBucketExpr returns a SQL expression that truncates the `ts` column to
// its minute boundary. SQLite uses strftime; postgres uses date_trunc.
func minuteBucketExpr(db *sqlx.DB) string {
	if db.DriverName() == "postgres" {
		return "date_trunc('minute', ts)"
	}
	return "strftime('%Y-%m-%d %H:%M:00', ts)"
}

// minuteNowExpr returns a SQL expression for the current minute boundary
// (server clock). Used as the cutoff for "closed" minute buckets.
func minuteNowExpr(db *sqlx.DB) string {
	if db.DriverName() == "postgres" {
		return "date_trunc('minute', now())"
	}
	return "strftime('%Y-%m-%d %H:%M:00', 'now')"
}

func hourBucketExpr(db *sqlx.DB) string {
	if db.DriverName() == "postgres" {
		return "date_trunc('hour', ts)"
	}
	return "strftime('%Y-%m-%d %H:00:00', ts)"
}

func hourNowExpr(db *sqlx.DB) string {
	if db.DriverName() == "postgres" {
		return "date_trunc('hour', now())"
	}
	return "strftime('%Y-%m-%d %H:00:00', 'now')"
}
