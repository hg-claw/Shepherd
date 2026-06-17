// Package sshaudit is a defensive-security plugin: it lets an operator audit
// SSH logins on their own managed fleet — view a host's current SSH sessions
// (live `who`) and its history of login successes/failures parsed from sshd
// journal/auth logs.
//
// No agent release is required. All host data is collected server-side via
// deps.HostExec.RunCmd over the existing PTY-script channel. This package
// owns the SCHEMA + REST surface + the parser + the background poller.
package sshaudit

import (
	"context"
	"log"
	"sync"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

// tickInterval is how often the background poller wakes to check which hosts
// are due for a collect. Each host's own poll_interval_seconds gates whether
// it actually runs on a given tick.
const tickInterval = 60 * time.Second

type Plugin struct {
	deps plugins.Deps // captured in RegisterRoutes; routes.go reads it

	mu      sync.Mutex
	cancel  context.CancelFunc // poller cancel; nil when not running
	wg      sync.WaitGroup     // tracks the poller goroutine for clean shutdown
	running map[int64]bool     // hosts with an in-flight collect (overlap guard)
}

func New() *Plugin { return &Plugin{running: map[int64]bool{}} }

func init() { plugins.Register(New()) }

func (p *Plugin) Meta() plugins.Meta                                  { return meta() }
func (p *Plugin) Migrations(driver shepdb.Driver) []plugins.Migration { return loadMigrations(driver) }

// OnEnable starts the single background poller goroutine. Idempotent: a
// second OnEnable while already running is a no-op.
func (p *Plugin) OnEnable(_ context.Context, deps plugins.Deps) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.deps = deps
	if p.cancel != nil {
		return nil // already running
	}
	if p.running == nil {
		p.running = map[int64]bool{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	p.wg.Add(1)
	go p.pollLoop(ctx, deps)
	return nil
}

// OnDisable cancels the poller context and waits for the goroutine to exit
// so there's no leak (must be -race clean).
func (p *Plugin) OnDisable(_ context.Context, _ plugins.Deps) error {
	p.mu.Lock()
	cancel := p.cancel
	p.cancel = nil
	p.mu.Unlock()
	if cancel != nil {
		cancel()
		p.wg.Wait()
	}
	return nil
}

// pollLoop ticks every tickInterval and collects due hosts. Kept trivial and
// separate from collectHost so unit tests never need to exercise the live
// ticker (project history: the ticker is a -race hazard in tests).
func (p *Plugin) pollLoop(ctx context.Context, deps plugins.Deps) {
	defer p.wg.Done()
	t := time.NewTicker(tickInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			p.pollDueHosts(ctx, deps)
		}
	}
}

// pollDueHosts lists enabled hosts and collects any that are due (never
// collected, or now-last_collect_at >= poll_interval_seconds).
func (p *Plugin) pollDueHosts(ctx context.Context, deps plugins.Deps) {
	now := deps.Now().UTC()
	var hosts []hostConfig
	if err := deps.DB.SelectContext(ctx, &hosts, `
		SELECT server_id, enabled, poll_interval_seconds, cursor_ts,
		       last_collect_at, last_error, updated_at
		  FROM sshaudit_hosts WHERE enabled = true`); err != nil {
		log.Printf("sshaudit poll: list hosts: %v", err)
		return
	}
	for _, h := range hosts {
		interval := time.Duration(h.PollIntervalSeconds) * time.Second
		due := h.LastCollectAt == nil || now.Sub(h.LastCollectAt.UTC()) >= interval
		if !due {
			continue
		}
		p.collectGuarded(ctx, deps, h.ServerID)
	}
}

// collectGuarded runs collectHost for one server unless a collect is already
// in flight for it. The guard prevents two ticks (or a tick + a manual
// /collect kick) from overlapping on the same host.
func (p *Plugin) collectGuarded(ctx context.Context, deps plugins.Deps, serverID int64) {
	p.mu.Lock()
	if p.running == nil {
		p.running = map[int64]bool{}
	}
	if p.running[serverID] {
		p.mu.Unlock()
		return
	}
	p.running[serverID] = true
	p.mu.Unlock()

	defer func() {
		p.mu.Lock()
		delete(p.running, serverID)
		p.mu.Unlock()
	}()

	if _, err := p.collectHost(ctx, deps, serverID); err != nil {
		log.Printf("sshaudit collect (server=%d): %v", serverID, err)
	}
}

// kickCollect runs a single best-effort collect in the background (used on
// enable and from the routes). Non-blocking. Tracked by wg so OnDisable's
// Wait sees it too — but since it uses background ctx it won't be cancelled,
// just awaited; collects are short one-shot host commands.
func (p *Plugin) kickCollect(deps plugins.Deps, serverID int64) {
	p.wg.Add(1)
	go func() {
		defer p.wg.Done()
		p.collectGuarded(context.Background(), deps, serverID)
	}()
}
