// Package singboxv2sampler polls sing-box's v2ray-api gRPC stats service for
// per-inbound cumulative byte counters and emits SingboxTrafficBatch
// envelopes via the agent's wire transport.
//
// Why this replaced singboxsampler (clash-api):
//
// clash-api's GET /connections only lists currently-active connections.
// Bytes accumulated since the last poll vanish when a connection closes —
// our delta-based aggregation systematically undercounts whenever traffic
// is bursty. v2ray-api's StatsService maintains tag-bound atomic Int64
// counters that survive connection close (see sing-box's
// experimental/v2rayapi/stats.go: counters are looked up per (inbound,
// outbound, user) and incremented on every Read/Write — closing the
// connection just stops further increments).
//
// QueryStats(pattern, reset=true) does an atomic swap on each matching
// counter — equivalent to "give me the delta since you last asked, and
// zero it." Our agent never needs to remember a previous snapshot; the
// counter is authoritative, and there's no race-with-close window.
package singboxv2sampler

import (
	"context"
	"log"
	"os"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	v2rayapi "github.com/sagernet/sing-box/experimental/v2rayapi"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// queryStatsFullMethod is the gRPC method path sing-box's StatsService
// actually serves on. Upstream's init() renames the server-side
// ServiceDesc.ServiceName from the proto's default
// "experimental.v2rayapi.StatsService" to v2ray-core's canonical
// "v2ray.core.app.stats.command.StatsService", but the auto-generated
// client stub in stats_grpc.pb.go still uses the original name — so the
// vendored client can't talk to its own server. Invoke the method
// directly with the renamed path; the request/response types are
// unaffected.
const queryStatsFullMethod = "/v2ray.core.app.stats.command.StatsService/QueryStats"

// singboxBinaryPath is where the sing-box plugin's Pusher.DeployService
// drops the binary. Presence ≡ "this host has sing-box managed by
// shepherd" — the sampler short-circuits when absent, otherwise the
// gRPC dial would log a connection-refused error every interval on
// hosts that never had the singbox plugin enabled.
const singboxBinaryPath = "/usr/local/bin/shepherd-singbox"

// pluginInstalledFn is the deploy-presence check. Overridden in tests so
// they don't depend on the binary actually being on disk.
var pluginInstalledFn = func() bool {
	_, err := os.Stat(singboxBinaryPath)
	return err == nil
}

// statsAddrDefault matches what render.go writes into
// experimental.v2ray_api.listen. Keep in sync.
const statsAddrDefault = "127.0.0.1:29091"

// Sampler periodically calls QueryStats on the sing-box v2ray-api gRPC
// endpoint and forwards parsed per-inbound deltas to Send.
type Sampler struct {
	// Address is the v2ray-api gRPC listen address. Defaults to
	// statsAddrDefault.
	Address string
	// Interval between polls. Defaults to 30s.
	Interval time.Duration
	// Send is called with each encoded SingboxTrafficBatch envelope. May be
	// nil (batches dropped). Send errors are logged but do not stop the loop.
	Send func(agentapi.Envelope) error

	// dial is swapped in tests with an in-memory bufconn. Returns a
	// ClientConnInterface (not the concrete *grpc.ClientConn) so tests
	// can supply a thin shim if they don't want a real conn closed.
	dial func(ctx context.Context, addr string) (closer func() error, cc grpc.ClientConnInterface, err error)
}

func (s *Sampler) effectiveAddress() string {
	if s.Address != "" {
		return s.Address
	}
	return statsAddrDefault
}

func (s *Sampler) effectiveInterval() time.Duration {
	if s.Interval > 0 {
		return s.Interval
	}
	return 30 * time.Second
}

// Run blocks until ctx is canceled, ticking every Interval.
func (s *Sampler) Run(ctx context.Context) {
	t := time.NewTicker(s.effectiveInterval())
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.tick(ctx)
		}
	}
}

// tick performs one QueryStats round and emits a SingboxTrafficBatch.
func (s *Sampler) tick(ctx context.Context) {
	if !pluginInstalledFn() {
		return
	}

	// Lazy-dial on every tick: a long-lived client conn would hide
	// sing-box restarts (gRPC keeps the conn cached in CONNECTING) and
	// confuse counter-reset semantics. The dial is local TCP — ~1ms,
	// not worth pooling.
	dctx, dcancel := context.WithTimeout(ctx, 5*time.Second)
	defer dcancel()
	closer, cc, err := s.dialer()(dctx, s.effectiveAddress())
	if err != nil {
		log.Printf("singboxv2sampler: dial %s: %v", s.effectiveAddress(), err)
		return
	}
	defer func() {
		if closer != nil {
			_ = closer()
		}
	}()

	qctx, qcancel := context.WithTimeout(ctx, 5*time.Second)
	defer qcancel()
	req := &v2rayapi.QueryStatsRequest{
		Pattern: "inbound>>>",
		// Reset_ = true asks sing-box to atomically swap each matched
		// counter to 0. The returned Value IS the delta since the last
		// reset → no prev-state bookkeeping in the agent. Equivalent to
		// s-ui's counter.Swap(0) pattern, just over gRPC.
		Reset_: true,
	}
	resp := &v2rayapi.QueryStatsResponse{}
	if err := cc.Invoke(qctx, queryStatsFullMethod, req, resp); err != nil {
		log.Printf("singboxv2sampler: QueryStats: %v", err)
		return
	}

	samples := parseStats(resp.GetStat(), time.Now().UTC())
	if len(samples) == 0 {
		return
	}

	env, err := agentapi.Frame(agentapi.TypeSingboxTraffic, agentapi.SingboxTrafficBatch{Samples: samples})
	if err != nil {
		log.Printf("singboxv2sampler: frame error: %v", err)
		return
	}
	if s.Send != nil {
		if err := s.Send(env); err != nil {
			log.Printf("singboxv2sampler: send failed (dropped): %v", err)
		}
	}
}

func (s *Sampler) dialer() func(context.Context, string) (func() error, grpc.ClientConnInterface, error) {
	if s.dial != nil {
		return s.dial
	}
	return dialGRPC
}

// dialGRPC dials the v2ray-api gRPC endpoint and returns a close func plus
// the conn interface to issue Invoke against.
func dialGRPC(_ context.Context, addr string) (func() error, grpc.ClientConnInterface, error) {
	conn, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, err
	}
	return conn.Close, conn, nil
}

// parseStats turns the raw stat list into SingboxTrafficSamples. Counters
// are named "inbound>>>{tag}>>>traffic>>>{uplink|downlink}" (see
// sing-box experimental/v2rayapi/stats.go), so per-tag uplink+downlink
// pairs need to be folded into a single sample row.
func parseStats(stats []*v2rayapi.Stat, ts time.Time) []agentapi.SingboxTrafficSample {
	if len(stats) == 0 {
		return nil
	}
	type ud struct{ up, down int64 }
	byTag := make(map[string]*ud, len(stats)/2)
	for _, st := range stats {
		tag, direction, ok := parseCounterName(st.GetName())
		if !ok {
			continue
		}
		entry, exists := byTag[tag]
		if !exists {
			entry = &ud{}
			byTag[tag] = entry
		}
		switch direction {
		case "uplink":
			entry.up += st.GetValue()
		case "downlink":
			entry.down += st.GetValue()
		}
	}
	out := make([]agentapi.SingboxTrafficSample, 0, len(byTag))
	for tag, e := range byTag {
		if e.up == 0 && e.down == 0 {
			continue // sing-box returns a zero entry for every tag in the
			// allowlist; suppress noise on the wire.
		}
		kind := "landing"
		if strings.HasPrefix(tag, "relay-") {
			kind = "relay"
		}
		out = append(out, agentapi.SingboxTrafficSample{
			Tag:       tag,
			Kind:      kind,
			TS:        ts,
			BytesUp:   e.up,
			BytesDown: e.down,
		})
	}
	return out
}

// parseCounterName extracts (tag, direction) from a v2ray-api counter
// name. Returns ok=false for any name that isn't shaped
// "inbound>>>{tag}>>>traffic>>>{uplink|downlink}" — we only sample
// inbounds, so outbound/user counters (if any operator ever enables
// them) are silently ignored.
func parseCounterName(name string) (tag, direction string, ok bool) {
	parts := strings.Split(name, ">>>")
	if len(parts) != 4 {
		return "", "", false
	}
	if parts[0] != "inbound" || parts[2] != "traffic" {
		return "", "", false
	}
	return parts[1], parts[3], true
}
