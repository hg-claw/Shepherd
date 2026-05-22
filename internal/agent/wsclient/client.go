package wsclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/agent/filehandler"
	"github.com/hg-claw/Shepherd/internal/agent/netinfo"
	"github.com/hg-claw/Shepherd/internal/agent/ptyrunner"
	"github.com/hg-claw/Shepherd/internal/agent/singboxv2sampler"
	"github.com/hg-claw/Shepherd/internal/agent/state"
	"github.com/hg-claw/Shepherd/internal/agent/xraysampler"
	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentconfig"
)

var ErrPermanent = errors.New("permanent agent failure")

type Client struct {
	Cfg        agentconfig.Config
	State      *state.Store
	HTTPClient *http.Client
	OnConfig   func(int) // called when server pushes config.update
	Hostname   string

	// TrafficSampler, if non-nil, is started as a goroutine after each WS connect.
	TrafficSampler *xraysampler.Sampler

	// SingboxTrafficSampler, if non-nil, is started as a goroutine after each WS connect.
	// Migrated from clash-api polling (singboxsampler) to v2ray-api gRPC
	// stats in v0.7.7 — the new sampler reads atomic-swap counters that
	// survive connection close, eliminating the under-counting we saw
	// under bursty traffic.
	SingboxTrafficSampler *singboxv2sampler.Sampler

	mu      sync.Mutex
	conn    *websocket.Conn
	runners *runners
}

func New(cfg agentconfig.Config, st *state.Store, onCfg func(int), hostname string) *Client {
	return &Client{
		Cfg:        cfg,
		State:      st,
		HTTPClient: &http.Client{Timeout: 30 * time.Second},
		OnConfig:   onCfg,
		Hostname:   hostname,
		runners:    newRunners(),
	}
}

// Run drives the agent lifecycle until ctx is canceled.
// Loop: ensure machine_token (enroll/auto-register if missing) -> dial WS -> read frames.
// Permanent errors abort with ErrPermanent (caller should exit non-zero).
func (c *Client) Run(ctx context.Context) error {
	backoff := time.Second
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		st, _ := c.State.Load()
		if st.MachineToken == "" {
			if err := c.acquireToken(ctx, st); err != nil {
				if errors.Is(err, ErrPermanent) {
					return err
				}
				log.Printf("token acquire: %v; retrying in %s", err, backoff)
				if !sleep(ctx, backoff) {
					return ctx.Err()
				}
				backoff = nextBackoff(backoff)
				continue
			}
		}
		err := c.dialAndRun(ctx)
		if errors.Is(err, ErrPermanent) {
			return err
		}
		log.Printf("ws session ended: %v; reconnecting in %s", err, backoff)
		if !sleep(ctx, backoff) {
			return ctx.Err()
		}
		backoff = nextBackoff(backoff)
	}
}

func (c *Client) acquireToken(ctx context.Context, st *state.State) error {
	if st.Fingerprint == "" {
		return errors.New("fingerprint missing")
	}

	// Collect IP candidates once; convert to wire type.
	netCands := netinfo.Collect(ctx)
	wireCands := make([]agentapi.IPCandidate, len(netCands))
	for i, nc := range netCands {
		wireCands[i] = agentapi.IPCandidate{Addr: nc.Addr, Kind: nc.Kind, Source: nc.Source}
	}

	switch {
	case c.Cfg.AutoRecoverKey != "":
		req := agentapi.AutoRegisterRequest{
			AutoRecoverKey: c.Cfg.AutoRecoverKey, Fingerprint: st.Fingerprint,
			Hostname: c.Hostname, OS: runtime.GOOS, Arch: runtime.GOARCH,
			Kernel: kernelVersion(), AgentVersion: c.Cfg.AgentVersion,
			IPCandidates: wireCands,
		}
		var resp agentapi.EnrollResponse
		if err := c.postJSON(ctx, "/agent/auto-register", req, &resp); err != nil {
			return err
		}
		st.MachineToken = resp.MachineToken
	case c.Cfg.EnrollmentToken != "":
		req := agentapi.EnrollRequest{
			EnrollmentToken: c.Cfg.EnrollmentToken, Fingerprint: st.Fingerprint,
			OS: runtime.GOOS, Arch: runtime.GOARCH, Kernel: kernelVersion(), AgentVersion: c.Cfg.AgentVersion,
			IPCandidates: wireCands,
		}
		var resp agentapi.EnrollResponse
		if err := c.postJSON(ctx, "/agent/enroll", req, &resp); err != nil {
			return err
		}
		st.MachineToken = resp.MachineToken
		c.Cfg.EnrollmentToken = "" // one-shot — drop after first use
	default:
		return errors.New("no ENROLLMENT_TOKEN nor AUTO_RECOVER_KEY")
	}
	if st.TelemetryIntervalSeconds == 0 {
		st.TelemetryIntervalSeconds = 30
	}
	return c.State.Save(st)
}

func (c *Client) postJSON(ctx context.Context, path string, body, out any) error {
	url := c.Cfg.ServerURL + path
	b, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return ErrPermanent
	}
	if resp.StatusCode/100 != 2 {
		return errors.New("non-2xx: " + string(data))
	}
	return json.Unmarshal(data, out)
}

func (c *Client) dialAndRun(ctx context.Context) error {
	st, _ := c.State.Load()
	if st.MachineToken == "" {
		return errors.New("no machine token")
	}

	wsURL := c.Cfg.WSURL()
	hdr := http.Header{}
	hdr.Set("Authorization", "Bearer "+st.MachineToken)

	dialer := *websocket.DefaultDialer
	dialer.HandshakeTimeout = 30 * time.Second
	conn, resp, err := dialer.DialContext(ctx, wsURL, hdr)
	if err != nil {
		if resp != nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
			if c.Cfg.AutoRecoverKey != "" {
				_ = c.State.Save(&state.State{Fingerprint: st.Fingerprint, TelemetryIntervalSeconds: st.TelemetryIntervalSeconds})
				return errors.New("token rejected; will re-register")
			}
			return ErrPermanent
		}
		return err
	}

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
		_ = conn.Close()
	}()

	// Collect IP candidates and attach to the first heartbeat of this WS session.
	netCands := netinfo.Collect(ctx)
	wireCands := make([]agentapi.IPCandidate, len(netCands))
	for i, nc := range netCands {
		wireCands[i] = agentapi.IPCandidate{Addr: nc.Addr, Kind: nc.Kind, Source: nc.Source}
	}
	hb, _ := agentapi.Frame(agentapi.TypeHeartbeat, agentapi.Heartbeat{
		TS: time.Now().UTC(), AgentVersion: c.Cfg.AgentVersion,
		OS: runtime.GOOS, Arch: runtime.GOARCH, Kernel: kernelVersion(),
		IPCandidates: wireCands,
	})
	if err := c.writeJSON(hb); err != nil {
		return err
	}

	stop := make(chan struct{})
	defer close(stop)
	go c.heartbeatLoop(stop)
	if c.TrafficSampler != nil {
		samplerCtx, samplerCancel := context.WithCancel(ctx)
		go func() {
			select {
			case <-stop:
				samplerCancel()
			case <-ctx.Done():
				samplerCancel()
			}
		}()
		go c.TrafficSampler.Run(samplerCtx)
	}
	if c.SingboxTrafficSampler != nil {
		sbCtx, sbCancel := context.WithCancel(ctx)
		go func() {
			select {
			case <-stop:
				sbCancel()
			case <-ctx.Done():
				sbCancel()
			}
		}()
		go c.SingboxTrafficSampler.Run(sbCtx)
	}
	// Close the connection when ctx is done so ReadMessage unblocks immediately.
	go func() {
		select {
		case <-stop:
		case <-ctx.Done():
			_ = conn.Close()
		}
	}()

	fh := filehandler.New(c)
	if st0, _ := c.State.Load(); st0.Sandbox != nil {
		enabled := false
		if st0.Sandbox.Enabled != nil {
			enabled = *st0.Sandbox.Enabled
		}
		fh.SetSandbox(&filehandler.Sandbox{Enabled: enabled, Allowed: st0.Sandbox.Paths})
	}
	return c.readPump(ctx, conn, fh)
}

// Send is the agent-side `Sender` impl used by the collector.
func (c *Client) Send(env agentapi.Envelope) error {
	return c.writeJSON(env)
}

func (c *Client) writeJSON(env agentapi.Envelope) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return errors.New("not connected")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteJSON(env)
}

func (c *Client) openPTY(ctx context.Context, p agentapi.PTYOpen) {
	r, err := ptyrunner.Spawn(ctx, ptyrunner.SpawnOpts{
		SID: p.Sid, Kind: p.Kind, User: p.User, Rows: p.Rows, Cols: p.Cols,
		Term: p.Term, Exec: p.Exec, Env: p.Env,
	}, c)
	if err != nil {
		exit, _ := agentapi.FrameSid(agentapi.TypePTYExit, p.Sid, agentapi.PTYExit{Sid: p.Sid, Code: 127})
		_ = c.writeJSON(exit)
		return
	}
	c.runners.addPTY(p.Sid, r)
}

func (c *Client) SendBinary(sid string, kind byte, payload []byte) error {
	buf, err := agentapi.EncodeBinary(sid, kind, payload)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return errors.New("not connected")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteMessage(websocket.BinaryMessage, buf)
}

func (c *Client) SendExit(sid string, code int) {
	exit, _ := agentapi.FrameSid(agentapi.TypePTYExit, sid, agentapi.PTYExit{Sid: sid, Code: code})
	_ = c.writeJSON(exit)
	c.runners.delPTY(sid)
}

func (c *Client) SendControl(env agentapi.Envelope) error { return c.writeJSON(env) }

func (c *Client) applyConfig(env agentapi.Envelope, fh *filehandler.Handler) {
	var u agentapi.ConfigUpdate
	if err := env.Decode(&u); err != nil {
		return
	}
	if u.TelemetryIntervalSeconds > 0 {
		if c.OnConfig != nil {
			c.OnConfig(u.TelemetryIntervalSeconds)
		}
		st, _ := c.State.Load()
		st.TelemetryIntervalSeconds = u.TelemetryIntervalSeconds
		_ = c.State.Save(st)
	}
	if u.FileSandboxEnabled != nil || u.FileSandboxPaths != nil {
		st, _ := c.State.Load()
		if st.Sandbox == nil {
			st.Sandbox = &state.SandboxState{}
		}
		if u.FileSandboxEnabled != nil {
			st.Sandbox.Enabled = u.FileSandboxEnabled
		}
		if u.FileSandboxPaths != nil {
			st.Sandbox.Paths = u.FileSandboxPaths
		}
		_ = c.State.Save(st)
		enabled := false
		if st.Sandbox.Enabled != nil {
			enabled = *st.Sandbox.Enabled
		}
		fh.SetSandbox(&filehandler.Sandbox{Enabled: enabled, Allowed: st.Sandbox.Paths})
	}
}

func (c *Client) heartbeatLoop(stop <-chan struct{}) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			env, _ := agentapi.Frame(agentapi.TypeHeartbeat, agentapi.Heartbeat{
				TS: time.Now().UTC(), AgentVersion: c.Cfg.AgentVersion,
				OS: runtime.GOOS, Arch: runtime.GOARCH, Kernel: kernelVersion(),
			})
			_ = c.writeJSON(env)
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func nextBackoff(d time.Duration) time.Duration {
	d *= 2
	if d > time.Minute {
		return time.Minute
	}
	return d
}

func kernelVersion() string {
	b, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
