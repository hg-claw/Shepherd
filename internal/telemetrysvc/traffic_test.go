package telemetrysvc

import (
	"context"
	"testing"
	"time"
)

func TestLastResetBoundary(t *testing.T) {
	utc := time.UTC
	now := time.Date(2026, 3, 20, 12, 0, 0, 0, utc)
	if got := lastResetBoundary(now, 1, utc); !got.Equal(time.Date(2026, 3, 1, 0, 0, 0, 0, utc)) {
		t.Errorf("after-day: %v", got)
	}
	now = time.Date(2026, 3, 5, 12, 0, 0, 0, utc)
	if got := lastResetBoundary(now, 10, utc); !got.Equal(time.Date(2026, 2, 10, 0, 0, 0, 0, utc)) {
		t.Errorf("before-day: %v", got)
	}
	now = time.Date(2026, 1, 5, 0, 0, 0, 0, utc)
	if got := lastResetBoundary(now, 10, utc); !got.Equal(time.Date(2025, 12, 10, 0, 0, 0, 0, utc)) {
		t.Errorf("jan-rollover: %v", got)
	}
	sh, _ := time.LoadLocation("Asia/Shanghai")
	now = time.Date(2026, 3, 20, 12, 0, 0, 0, sh)
	w := lastResetBoundary(now, 1, sh).In(sh)
	if w.Year() != 2026 || w.Month() != 3 || w.Day() != 1 || w.Hour() != 0 {
		t.Errorf("tz boundary wall-clock: %v", w)
	}
}

func TestQuery_HostTraffic_DefaultWhenAbsent(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	row, err := q.HostTraffic(context.Background(), sid)
	if err != nil {
		t.Fatal(err)
	}
	if row.ResetDay != 1 || row.CumBytesUp != 0 || row.LastResetAt != nil {
		t.Fatalf("absent default: %+v", row)
	}
}

func TestQuery_SetResetDay_And_ResetNow(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()
	if err := q.SetTrafficResetDay(ctx, sid, 15); err != nil {
		t.Fatal(err)
	}
	_, _ = ing.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=500, cum_bytes_down=900 WHERE server_id=$1`, sid)
	if err := q.ResetTrafficNow(ctx, sid); err != nil {
		t.Fatal(err)
	}
	row, _ := q.HostTraffic(ctx, sid)
	if row.ResetDay != 15 || row.CumBytesUp != 0 || row.CumBytesDown != 0 || row.PrevBytesUp != 500 || row.PrevBytesDown != 900 {
		t.Fatalf("after reset: %+v", row)
	}
	if row.LastResetAt == nil {
		t.Fatal("last_reset_at should be set after reset")
	}
}

func TestQuery_ResetDueTraffic(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()
	_ = q.SetTrafficResetDay(ctx, sid, 1)
	_, _ = ing.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=10, cum_bytes_down=20, last_reset_at=$1 WHERE server_id=$2`,
		time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), sid)
	now := time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC)
	if err := q.ResetDueTraffic(ctx, now, time.UTC); err != nil {
		t.Fatal(err)
	}
	row, _ := q.HostTraffic(ctx, sid)
	if row.CumBytesUp != 0 || row.PrevBytesUp != 10 {
		t.Fatalf("due not reset: %+v", row)
	}
	if err := q.ResetDueTraffic(ctx, now, time.UTC); err != nil {
		t.Fatal(err)
	}
	row, _ = q.HostTraffic(ctx, sid)
	if row.PrevBytesUp != 10 {
		t.Fatalf("second run should be no-op: %+v", row)
	}
}
