package telemetrysvc

import (
	"context"
	"testing"
	"time"
)

type fakeSettings struct{ tz string }

func (f fakeSettings) Get(_ context.Context, key string) (string, error) {
	if key == "traffic_reset_tz" {
		return f.tz, nil
	}
	return "", nil
}

func TestTrafficReset_TickResetsDue(t *testing.T) {
	ing, sid := newIngest(t)
	q := &Query{DB: ing.DB}
	ctx := context.Background()
	_ = q.SetTrafficResetDay(ctx, sid, 1)
	_, _ = ing.DB.ExecContext(ctx, `UPDATE host_traffic SET cum_bytes_up=7, last_reset_at=$1 WHERE server_id=$2`,
		time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC), sid)

	tr := &TrafficReset{DB: ing.DB, Settings: fakeSettings{tz: "UTC"}}
	if err := tr.Tick(ctx); err != nil {
		t.Fatal(err)
	}
	row, _ := q.HostTraffic(ctx, sid)
	if row.CumBytesUp != 0 || row.PrevBytesUp != 7 {
		t.Fatalf("tick did not reset: %+v", row)
	}
}
