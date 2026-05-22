package singboxv2sampler

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	v2rayapi "github.com/sagernet/sing-box/experimental/v2rayapi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

// fakeStatsServer is a tiny in-memory v2ray-api StatsService that returns
// whatever stats the test sets, and records the most recent QueryStats
// request so we can assert pattern/reset.
type fakeStatsServer struct {
	v2rayapi.UnimplementedStatsServiceServer
	stats       []*v2rayapi.Stat
	lastPattern string
	lastReset   bool
}

func (f *fakeStatsServer) QueryStats(ctx context.Context, req *v2rayapi.QueryStatsRequest) (*v2rayapi.QueryStatsResponse, error) {
	f.lastPattern = req.GetPattern()
	f.lastReset = req.GetReset_()
	return &v2rayapi.QueryStatsResponse{Stat: f.stats}, nil
}

// startBufconnServer spins up a gRPC server backed by an in-process listener
// and returns a dialer that the Sampler can use without touching the network.
//
// Crucially RegisterStatsServiceServer runs upstream's init() which renames
// the server-side ServiceDesc, so the bufconn server registers at the same
// "/v2ray.core.app.stats.command.StatsService/QueryStats" path the
// production sampler invokes — verifying both ends agree on the rename.
func startBufconnServer(t *testing.T, svc *fakeStatsServer) func(context.Context, string) (func() error, grpc.ClientConnInterface, error) {
	t.Helper()
	lis := bufconn.Listen(1 << 16)
	srv := grpc.NewServer()
	v2rayapi.RegisterStatsServiceServer(srv, svc)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(func() {
		srv.GracefulStop()
		_ = lis.Close()
	})
	return func(ctx context.Context, _ string) (func() error, grpc.ClientConnInterface, error) {
		conn, err := grpc.NewClient(
			"passthrough://bufnet",
			grpc.WithContextDialer(func(_ context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		)
		if err != nil {
			return nil, nil, err
		}
		return conn.Close, conn, nil
	}
}

func init() {
	// Default: pretend the plugin is installed so the gate doesn't
	// short-circuit every test.
	pluginInstalledFn = func() bool { return true }
}

func TestSampler_TickEmitsBatchAndAtomicResets(t *testing.T) {
	svc := &fakeStatsServer{stats: []*v2rayapi.Stat{
		{Name: "inbound>>>landing-aaa>>>traffic>>>uplink", Value: 1024},
		{Name: "inbound>>>landing-aaa>>>traffic>>>downlink", Value: 2048},
		{Name: "inbound>>>relay-bbb>>>traffic>>>uplink", Value: 4096},
		{Name: "inbound>>>relay-bbb>>>traffic>>>downlink", Value: 8192},
	}}
	var sent []agentapi.SingboxTrafficBatch
	s := &Sampler{
		Send: func(env agentapi.Envelope) error {
			var b agentapi.SingboxTrafficBatch
			if err := env.Decode(&b); err != nil {
				return err
			}
			sent = append(sent, b)
			return nil
		},
		dial: startBufconnServer(t, svc),
	}
	s.tick(context.Background())

	// Atomic-swap semantics: the agent must always ask for reset=true so the
	// returned values are deltas, not running totals.
	if !svc.lastReset {
		t.Errorf("QueryStats called with reset=false; need reset=true for delta semantics")
	}
	if svc.lastPattern != "inbound>>>" {
		t.Errorf("QueryStats pattern = %q, want %q", svc.lastPattern, "inbound>>>")
	}

	if len(sent) != 1 {
		t.Fatalf("expected 1 batch sent, got %d", len(sent))
	}
	got := map[string]agentapi.SingboxTrafficSample{}
	for _, s := range sent[0].Samples {
		got[s.Tag] = s
	}
	if got["landing-aaa"].BytesUp != 1024 || got["landing-aaa"].BytesDown != 2048 || got["landing-aaa"].Kind != "landing" {
		t.Errorf("landing-aaa = %+v, want {Up:1024, Down:2048, Kind:landing}", got["landing-aaa"])
	}
	if got["relay-bbb"].BytesUp != 4096 || got["relay-bbb"].BytesDown != 8192 || got["relay-bbb"].Kind != "relay" {
		t.Errorf("relay-bbb = %+v, want {Up:4096, Down:8192, Kind:relay}", got["relay-bbb"])
	}
}

func TestSampler_TickSkipsWhenPluginAbsent(t *testing.T) {
	orig := pluginInstalledFn
	pluginInstalledFn = func() bool { return false }
	t.Cleanup(func() { pluginInstalledFn = orig })

	var sent int
	dialCalled := false
	s := &Sampler{
		Send: func(agentapi.Envelope) error { sent++; return nil },
		dial: func(context.Context, string) (func() error, grpc.ClientConnInterface, error) {
			dialCalled = true
			return nil, nil, errors.New("should not be called")
		},
	}
	s.tick(context.Background())
	if dialCalled {
		t.Error("dial was called despite pluginInstalledFn returning false")
	}
	if sent != 0 {
		t.Errorf("Send called %d times; want 0", sent)
	}
}

func TestSampler_TickSuppressesEmptyBatches(t *testing.T) {
	// sing-box returns a Stat entry for every tag in the allowlist even
	// when bytes_up == bytes_down == 0. Don't waste WS frames on idle tags.
	svc := &fakeStatsServer{stats: []*v2rayapi.Stat{
		{Name: "inbound>>>landing-idle>>>traffic>>>uplink", Value: 0},
		{Name: "inbound>>>landing-idle>>>traffic>>>downlink", Value: 0},
	}}
	var sent int
	s := &Sampler{
		Send: func(agentapi.Envelope) error { sent++; return nil },
		dial: startBufconnServer(t, svc),
	}
	s.tick(context.Background())
	if sent != 0 {
		t.Errorf("Send called %d times on all-zero batch; want 0", sent)
	}
}

func TestSampler_RunHonoursContextCancel(t *testing.T) {
	svc := &fakeStatsServer{}
	s := &Sampler{
		Interval: 10 * time.Millisecond,
		dial:     startBufconnServer(t, svc),
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { s.Run(ctx); close(done) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Run did not exit within 1s of ctx.Cancel")
	}
}

func TestParseCounterName(t *testing.T) {
	cases := []struct {
		in        string
		tag, dir  string
		ok        bool
	}{
		{"inbound>>>landing-aabb>>>traffic>>>uplink", "landing-aabb", "uplink", true},
		{"inbound>>>relay-ccdd>>>traffic>>>downlink", "relay-ccdd", "downlink", true},
		{"outbound>>>direct>>>traffic>>>uplink", "", "", false},
		{"user>>>alice>>>traffic>>>uplink", "", "", false},
		{"inbound>>>tag>>>not_traffic>>>uplink", "", "", false},
		{"too>>>few>>>parts", "", "", false},
		{"", "", "", false},
	}
	for _, c := range cases {
		tag, dir, ok := parseCounterName(c.in)
		if tag != c.tag || dir != c.dir || ok != c.ok {
			t.Errorf("parseCounterName(%q) = (%q, %q, %v); want (%q, %q, %v)",
				c.in, tag, dir, ok, c.tag, c.dir, c.ok)
		}
	}
}
