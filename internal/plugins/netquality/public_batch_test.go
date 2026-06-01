package netquality

import (
	"context"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func TestLatestPerISPForAll(t *testing.T) {
	db := openTestDB(t)
	for _, m := range New().Migrations(shepdb.DriverSQLite) {
		if _, err := db.Exec(m.SQL); err != nil {
			t.Fatalf("apply migration %s: %v", m.Name, err)
		}
	}

	mk := func(name string) int64 {
		res, err := db.Exec("INSERT INTO servers(name) VALUES ($1)", name)
		if err != nil {
			t.Fatalf("insert server %s: %v", name, err)
		}
		id, _ := res.LastInsertId()
		return id
	}
	s1, s2 := mk("a"), mk("b")
	now := time.Now().UTC()

	if _, err := db.Exec(
		`INSERT INTO netquality_hosts(server_id, enabled, updated_at) VALUES (?,1,?),(?,1,?)`,
		s1, now, s2, now,
	); err != nil {
		t.Fatalf("insert hosts: %v", err)
	}

	res, err := db.Exec(
		`INSERT INTO netquality_targets(source, isp, region, label, host, enabled, created_at)
		 VALUES ('custom','telecom','Shanghai','Test','1.1.1.1',1,$1)`, now,
	)
	if err != nil {
		t.Fatalf("insert target: %v", err)
	}
	tid, _ := res.LastInsertId()

	if _, err := db.Exec(
		`INSERT INTO netquality_samples_raw(server_id, target_id, ts, rtt_avg_ms, loss_pct, status)
		 VALUES ($1,$2,$3,20,0,'ok')`, s1, tid, now,
	); err != nil {
		t.Fatalf("insert sample: %v", err)
	}

	m := LatestPerISPForAll(context.Background(), db, []int64{s1, s2})
	if len(m[s1]) != 1 || m[s1][0].ISP != "telecom" {
		t.Fatalf("s1 summary wrong: %+v", m[s1])
	}
	if len(m[s2]) != 0 {
		t.Fatalf("s2 has no samples, want empty, got %+v", m[s2])
	}
}
