package telemetrysvc

import (
	"context"
	"testing"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/livenet"
)

type capConn struct{ got []agentapi.LiveNetSample }

func (c *capConn) WriteJSON(v any) error {
	c.got = append(c.got, v.(agentapi.LiveNetSample))
	return nil
}

func TestHandleFrame_LiveNet_ToHubNotAccumulated(t *testing.T) {
	ing, sid := newIngest(t)
	hub := livenet.NewHub()
	ing.LiveNet = hub
	conn := &capConn{}
	detach := hub.Attach(sid, conn)
	defer detach()

	env, _ := agentapi.Frame(agentapi.TypeLiveNet, agentapi.LiveNetSample{RxBps: 123, TxBps: 456})
	ing.HandleFrame(context.Background(), sid, env)

	if len(conn.got) != 1 || conn.got[0].RxBps != 123 {
		t.Fatalf("hub did not get sample: %+v", conn.got)
	}
	var n int
	_ = ing.DB.QueryRowContext(context.Background(), `SELECT COUNT(*) FROM host_traffic WHERE server_id=$1`, sid).Scan(&n)
	if n != 0 {
		t.Fatalf("live.net must not write host_traffic, got %d rows", n)
	}
}
