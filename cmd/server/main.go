package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/api"
	"github.com/hg-claw/Shepherd/internal/audit"
	"github.com/hg-claw/Shepherd/internal/auth"
	"github.com/hg-claw/Shepherd/internal/config"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/filesvc"
	"github.com/hg-claw/Shepherd/internal/installer"
	"github.com/hg-claw/Shepherd/internal/plugins"
	_ "github.com/hg-claw/Shepherd/internal/plugins/cloudflare"                // registers via init()
	netqualityplugin "github.com/hg-claw/Shepherd/internal/plugins/netquality" // registers via init() + WS push helper
	singboxplugin "github.com/hg-claw/Shepherd/internal/plugins/singbox"       // registers via init()
	subgen "github.com/hg-claw/Shepherd/internal/plugins/subgen"               // registers via init() + public /sub wiring
	xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray"             // registers via init() + Migrate0003

	"github.com/hg-claw/Shepherd/internal/livenet"
	"github.com/hg-claw/Shepherd/internal/ptysvc"
	"github.com/hg-claw/Shepherd/internal/scriptsvc"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
	"github.com/hg-claw/Shepherd/internal/singbox/certmgr"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
	shepweb "github.com/hg-claw/Shepherd/internal/web"
	"github.com/jmoiron/sqlx"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		log.Fatalf("config: %v", err)
	}

	rootCtx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	d, err := shepdb.Open(rootCtx, shepdb.Config{Driver: cfg.DBDriver, DSN: cfg.DBDSN})
	if err != nil {
		log.Fatalf("db open: %v", err)
	}
	defer func() { _ = d.Close() }()
	if err := shepdb.Migrate(d, cfg.DBDriver); err != nil {
		log.Fatalf("db migrate: %v", err)
	}

	authStore := &auth.Store{DB: d}
	authH := &auth.Handler{Store: authStore, Secure: cfg.CookieSecure}

	bootstrapInitialAdmin(rootCtx, d, authStore, cfg.InitialAdminUsername, cfg.InitialAdminPassword)

	serverSvc := &serversvc.Service{DB: d}
	settingsStore := &serversvc.SettingsStore{DB: d}
	agentSvc := &agentsvc.Service{DB: d, AutoRecoverKey: cfg.AutoRecoverKey}
	hub := agentsvc.NewHub()
	tQuery := &telemetrysvc.Query{DB: d}
	liveNetHub := livenet.NewHub()
	tIngest := &telemetrysvc.Ingest{DB: d, LiveNet: liveNetHub}
	// pluginStore is constructed early so the per-plugin rollups can
	// poll the enabled flag and short-circuit when the plugin isn't
	// in use on this deployment. Pre-fix these goroutines ran 24/7
	// against tables that may not even exist (sqlite default install),
	// flooding the log with "no such table" errors.
	pluginStore := &plugins.Store{DB: d, Now: time.Now}

	trafficRollup := &telemetrysvc.TrafficRollup{
		DB:      d,
		Enabled: pluginEnabledChecker(rootCtx, pluginStore, "xray"),
	}
	go trafficRollup.Run(rootCtx)

	// sing-box traffic rollup (mirrors xray TrafficRollup).
	sbRollup := &telemetrysvc.SingboxTrafficRollup{
		DB:      d,
		Enabled: pluginEnabledChecker(rootCtx, pluginStore, "singbox"),
	}
	go sbRollup.Run(rootCtx)

	// netquality rollup (same shape — raw → minute → hour, retention
	// 24h / 7d / 90d). Gated on the netquality plugin being enabled so
	// fresh installs that never turn it on don't pay any DB cost.
	nqRollup := &telemetrysvc.NetqualityRollup{
		DB:      d,
		Enabled: pluginEnabledChecker(rootCtx, pluginStore, "netquality"),
	}
	go nqRollup.Run(rootCtx)

	reg := sessionmux.New()
	auditW := &audit.Writer{DB: d, Now: time.Now}

	ptyService := &ptysvc.Service{
		DB:            d,
		Hub:           hub,
		Reg:           reg,
		Audit:         auditW,
		Now:           time.Now,
		RecordingsDir: filepath.Join(cfg.DataDir, "pty-recordings"),
	}

	scriptsStore := &scriptsvc.Store{DB: d, Now: time.Now}
	scriptsService := &scriptsvc.Service{
		DB:    d,
		Store: scriptsStore,
		PTY:   ptyService,
		Reg:   reg,
		Audit: auditW,
		Now:   time.Now,
	}
	ptyService.OnSessionFinalized = scriptsService.OnPTYExit

	filesService := &filesvc.Service{Hub: hub, Reg: reg}

	sandboxPusher := &serversvc.SandboxPusher{Settings: settingsStore, Hub: hub}

	if err := ptyService.Sweep(rootCtx); err != nil {
		log.Printf("pty sweep: %v", err)
	}
	if err := scriptsService.Sweep(rootCtx); err != nil {
		log.Printf("scripts sweep: %v", err)
	}

	go (&audit.Retention{DB: d, Settings: settingsStore, Now: time.Now}).Run(rootCtx)

	var dist installer.Distribution
	switch cfg.AgentDistribution {
	case config.DistributionEmbedded:
		dist = installer.EmbeddedDistribution{}
	case config.DistributionGitHub:
		dist = installer.GitHubDistribution{
			Owner: "hg-claw",
			Repo:  "Shepherd",
			Tag:   tagOrFallback(cfg.AgentDownloadTag, cfg.BuildVersion),
		}
	default:
		log.Fatalf("unknown distribution: %q", cfg.AgentDistribution)
	}
	inst := &installer.Installer{Distribution: dist}
	installMgr := &serversvc.InstallManager{
		Service:   serverSvc,
		Installer: inst,
		Tokens:    agentSvc,
		ServerURL: deriveServerURL(cfg),
		Ctx:       rootCtx,
	}

	if err := installMgr.SweepStuck(rootCtx); err != nil {
		log.Printf("sweep stuck: %v", err)
	}

	go (&telemetrysvc.Rollup{DB: d}).Run(rootCtx)
	go (&telemetrysvc.Retention{
		DB:       d,
		Settings: settingsStore,
		// Plugin-owned tables: skip retention when the row is absent
		// (plugin never enabled → tables don't exist), when enabled=false,
		// OR on a transient lookup error (skipping is cheap; the loop
		// will succeed next interval and stop spamming "no such table").
		PluginEnabled: func(id string) bool {
			row, err := pluginStore.Get(rootCtx, id)
			return err == nil && row.Enabled
		},
	}).Run(rootCtx)
	go (&telemetrysvc.TrafficReset{DB: d, Settings: settingsStore}).Run(rootCtx)

	authAPI := &api.AuthAPI{Auth: authH}
	// hostExec is constructed before ServersAPI so UpdateAgent can borrow
	// it; the same instance is also handed to pluginsDeps below.
	hostExec := &plugins.HubHostExec{Hub: hub, Files: filesService, Reg: reg}
	servers := &api.ServersAPI{
		Servers: serverSvc, Settings: settingsStore, Query: tQuery, Hub: hub,
		InstallManager: installMgr, Tokens: agentSvc,
		HostExec:     hostExec,
		BuildVersion: cfg.BuildVersion,
		PublicURL:    deriveServerURL(cfg),
	}
	settings := &api.SettingsAPI{
		Settings:        settingsStore,
		OnSandboxChange: sandboxPusher.PushAll,
	}
	public := &api.PublicAPI{Servers: serverSvc, Settings: settingsStore, Query: tQuery, Hub: hub, Tokens: agentSvc, BuildVersion: cfg.BuildVersion}
	// Public-wall augmentation: when the netquality plugin is linked
	// (it always is in this binary), fold its per-ISP RTT averages into
	// each public card. The closure copies the typed plugin result into
	// the api package's local type to keep the import direction clean.
	// Both public-facing netquality closures gate on the plugin's
	// system-level enabled flag BEFORE touching the netquality_*
	// tables. The plugin's migrations only run on first OnEnable, so
	// hosts where the operator never enabled the plugin don't have
	// those tables at all — calling LatestPerISP / LatestHistory
	// without this guard would issue a doomed query per server per
	// wall refresh. The two-level rule "show iff plugin AND host both
	// enabled" is enforced here (plugin) + inside the helpers (host).
	isNetqualityOn := pluginEnabledChecker(rootCtx, pluginStore, "netquality")
	public.NetqualitySummary = func(ctx context.Context, serverID int64) []api.NetqualityISPSummary {
		if !isNetqualityOn() {
			return nil
		}
		rows := netqualityplugin.LatestPerISP(ctx, d, serverID)
		out := make([]api.NetqualityISPSummary, 0, len(rows))
		for _, r := range rows {
			out = append(out, api.NetqualityISPSummary{ISP: r.ISP, RTTAvgMs: r.RTTAvgMs, LossPct: r.LossPct})
		}
		return out
	}
	public.NetqualityHistory = func(ctx context.Context, serverID int64, rng string) []api.NetqualityISPHistoryRow {
		if !isNetqualityOn() {
			return nil
		}
		rows := netqualityplugin.LatestHistory(ctx, d, serverID, netqualityplugin.HistoryRange(rng))
		out := make([]api.NetqualityISPHistoryRow, 0, len(rows))
		for _, r := range rows {
			pts := make([]api.NetqualityISPHistoryPoint, 0, len(r.Points))
			for _, p := range r.Points {
				pts = append(pts, api.NetqualityISPHistoryPoint{
					TS:       p.TS,
					RTTAvgMs: p.RTTAvgMs,
					LossPct:  p.LossPct,
				})
			}
			out = append(out, api.NetqualityISPHistoryRow{ISP: r.ISP, Points: pts})
		}
		return out
	}
	public.InitRateLimit(30, time.Minute)
	agentAPI := &api.AgentAPI{
		Agents:            agentSvc,
		Hub:               hub,
		OnFrame:           tIngest.HandleFrame,
		Reg:               reg,
		OnAgentDisconnect: ptyService.AgentDisconnected,
		PushSandbox:       func(serverID int64) { sandboxPusher.PushOne(rootCtx, serverID) },
		PushNetquality:    func(serverID int64) { netqualityplugin.PushConfig(rootCtx, d, hub.Send, serverID) },
	}

	consoleAPI := &api.ConsoleAPI{PTY: ptyService}
	scriptsAPI := &api.ScriptsAPI{Store: scriptsStore, Service: scriptsService}
	filesAPI := &api.FilesAPI{
		Files:     filesService,
		Audit:     auditW,
		MaxUpload: int64(settingsStore.GetInt(rootCtx, "file_upload_max_bytes", 100*1024*1024)),
	}
	auditAPI := &api.AuditAPI{DB: d}
	recAPI := &api.RecordingsAPI{DB: d}

	// hostExec was constructed above (before ServersAPI) and is shared here
	// for plugin-initiated exec. No DB row is written for plugin-initiated
	// exec; sessions are ephemeral.
	pluginsDeps := plugins.Deps{
		DB:       d,
		DataDir:  filepath.Join(cfg.DataDir, "plugins"),
		HostExec: hostExec,
		Now:      time.Now,
		HubSend:  hub.Send,
	}
	pluginsAPI := &api.PluginsAPI{
		Store:  pluginStore,
		Deps:   pluginsDeps,
		Driver: cfg.DBDriver,
		SecretFields: map[string][]string{
			"cloudflare": {"api_token"},
		},
	}
	// Catch plugins whose migrations were added after the plugin was already
	// enabled (the enable handler short-circuits on already-enabled rows and
	// never re-runs migrations). The migration runner is idempotent via the
	// plugin_migrations ledger, so this is safe to run unconditionally.
	for _, p := range plugins.All() {
		row, err := pluginStore.Get(rootCtx, p.Meta().ID)
		if err != nil || !row.Enabled {
			continue
		}
		if err := plugins.RunPluginMigrations(rootCtx, d, p.Meta().ID, p.Migrations(cfg.DBDriver)); err != nil {
			log.Printf("plugin %s: boot migrate: %v", p.Meta().ID, err)
		}
		if p.Meta().ID == "xray" {
			if err := xrayplugin.Migrate0003(rootCtx, d); err != nil {
				log.Printf("xray.Migrate0003: %v", err)
				// continue — don't crash boot
			}
		}
	}

	// sing-box cert renewal loop.
	// The cfTokenProvider reads the Cloudflare API token from the plugins table at
	// issuance time so it always sees the current value without a restart.
	sbCertStore := &singboxplugin.CertStore{DB: d, Now: time.Now}
	sbCertMgr := certmgr.NewManager(certmgr.Config{
		Store:           &certStoreAdapter{store: sbCertStore},
		CFTokenProvider: &cfTokenProvider{store: pluginStore},
		// Default contact used only when the caller (renewal loop) does
		// not supply one. Must be a syntactically valid address — LE
		// rejects host parts with no dot, which the old
		// "shepherd@localhost" tripped on.
		Email:            "shepherd-acme@example.invalid",
		HTTP01ListenAddr: ":80",
		CADirectoryURL:   "", // empty = Let's Encrypt production
	})
	go sbCertMgr.RunRenewalLoop(rootCtx, 24*time.Hour)

	// Wire real issue / renew implementations into the cert HTTP handlers.
	// certID must reach Manager so it can write back to the right row —
	// dropping it (the pre-fix behaviour) left every cert stuck at
	// status='issuing' with empty last_error.
	singboxplugin.SetCertFuncs(
		func(ctx context.Context, certID int64, domain, challengeType, email string) error {
			ch := certmgr.HTTP01
			if challengeType == "dns-01-cf" {
				ch = certmgr.DNS01CF
			}
			return sbCertMgr.Issue(ctx, certID, domain, ch, email)
		},
		func(ctx context.Context, certID int64, domain, challengeType, _ string) error {
			ch := certmgr.HTTP01
			if challengeType == "dns-01-cf" {
				ch = certmgr.DNS01CF
			}
			return sbCertMgr.Renew(ctx, certID, domain, ch)
		},
	)

	eventsAPI := &api.PluginEventsAPI{DB: d}
	logsAPI := &api.PluginLogsAPI{HostExec: hostExec, Deps: pluginsDeps}

	subgenStore := &subgen.Store{DB: d, Now: time.Now}
	subgenSvc := &subgen.Service{
		Store:       subgenStore,
		Now:         time.Now,
		RulesetBase: subgen.DefaultRulesetBase,
		PublicURL:   deriveServerURL(cfg),
	}
	subgenAPI := &api.SubgenAPI{Service: subgenSvc}
	subgenAPI.InitRateLimit(60, time.Minute)

	router := api.NewRouter(authAPI, authH.RequireAdmin,
		servers, settings, public, agentAPI,
		consoleAPI, scriptsAPI, filesAPI, auditAPI, recAPI,
		shepweb.Handler(), subgenAPI).
		WithPlugins(pluginsAPI, eventsAPI, logsAPI)
	router.LiveNet = &api.LiveNetAPI{Hub: liveNetHub}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           router.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("listening on %s (driver=%s, distribution=%s, version=%s)",
			cfg.HTTPAddr, cfg.DBDriver, cfg.AgentDistribution, cfg.BuildVersion)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()

	<-rootCtx.Done()
	shutdownCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
	defer c()
	_ = srv.Shutdown(shutdownCtx)
}

// cfTokenProvider implements certmgr.CFTokenProvider.
// It reads the Cloudflare API token from the plugins table on every call so
// that token rotations take effect without restarting the server.
type cfTokenProvider struct {
	store *plugins.Store
}

func (p *cfTokenProvider) Token(ctx context.Context) (string, error) {
	row, err := p.store.Get(ctx, "cloudflare")
	if err != nil || !row.Enabled || len(row.ConfigJSON) == 0 {
		return "", nil // cloudflare plugin not enabled — DNS-01 unavailable
	}
	var cfg struct {
		APIToken string `json:"api_token"`
	}
	if err := json.Unmarshal(row.ConfigJSON, &cfg); err != nil {
		return "", nil
	}
	return cfg.APIToken, nil
}

// certStoreAdapter bridges singboxplugin.CertStore to certmgr.Store.
// certmgr.Store.ListExpiringSoon takes a time.Duration, while CertStore takes
// an int (days). This adapter converts between the two representations.
type certStoreAdapter struct {
	store *singboxplugin.CertStore
}

func (a *certStoreAdapter) UpsertCert(ctx context.Context, id int64, certPEM, keyPEM string, expiresAt time.Time) error {
	return a.store.UpsertCert(ctx, id, certPEM, keyPEM, expiresAt)
}

func (a *certStoreAdapter) UpsertStatus(ctx context.Context, id int64, status string, lastErr *string) error {
	return a.store.UpsertStatus(ctx, id, status, lastErr)
}

func (a *certStoreAdapter) ListExpiringSoon(ctx context.Context, within time.Duration) ([]certmgr.RenewalTarget, error) {
	days := int(within.Hours() / 24)
	if days < 1 {
		days = 1
	}
	rows, err := a.store.ListExpiringSoon(ctx, days)
	if err != nil {
		return nil, err
	}
	out := make([]certmgr.RenewalTarget, 0, len(rows))
	for _, r := range rows {
		ch := certmgr.HTTP01
		if r.ChallengeType == "dns-01-cf" {
			ch = certmgr.DNS01CF
		}
		out = append(out, certmgr.RenewalTarget{
			ID:        r.ID,
			Domain:    r.Domain,
			Challenge: ch,
		})
	}
	return out, nil
}

func tagOrFallback(override, build string) string {
	if override != "" {
		return override
	}
	if build == "dev" {
		return "v0.1.0"
	}
	return build
}

func deriveServerURL(cfg config.Config) string {
	if cfg.ServerPublicURL != "" {
		return cfg.ServerPublicURL
	}
	addr := cfg.HTTPAddr
	if addr == "" {
		addr = ":8080"
	}
	return "http://localhost" + addr
}

// bootstrapInitialAdmin ensures the admins table has at least one entry on
// startup. Pre-fix this was a no-op when both INITIAL_ADMIN_* envs were
// empty, so a default `docker compose up` left the install with no way
// to log in. Now we always create an admin when the table is empty:
//
//   - both envs set         → use them (deterministic, useful for IaC)
//   - either env missing    → fall back to username "admin" and a random
//     24-byte URL-safe password, logged ONCE in a
//     loud banner that users can grep from
//     `docker compose logs`.
//
// If the admins table already has rows, this is a no-op.
func bootstrapInitialAdmin(ctx context.Context, d *sqlx.DB, store *auth.Store, envUser, envPass string) {
	var n int
	if err := d.Get(&n, "SELECT COUNT(*) FROM admins"); err != nil {
		log.Fatalf("count admins: %v", err)
	}
	if n > 0 {
		return
	}
	user := envUser
	if user == "" {
		user = "admin"
	}
	pass := envPass
	generated := false
	if pass == "" {
		p, err := randomPassword(24)
		if err != nil {
			log.Fatalf("generate initial admin password: %v", err)
		}
		pass = p
		generated = true
	}
	if _, err := store.CreateAdmin(ctx, user, pass); err != nil {
		log.Fatalf("create initial admin: %v", err)
	}
	if generated {
		log.Printf("================================================================")
		log.Printf("  Created initial admin: %s", user)
		log.Printf("  Generated password:    %s", pass)
		log.Printf("  Shown only once. Save it now, or recreate via DB.")
		log.Printf("================================================================")
		return
	}
	log.Printf("created initial admin %q (password from INITIAL_ADMIN_PASSWORD)", user)
}

// pluginEnabledChecker returns an `Enabled func() bool` closure that gates
// per-plugin rollup work on the plugin row's enabled flag. Skips when the
// row is missing (plugin never enabled → migrations never ran → tables
// don't exist) or on a transient lookup error — both cases would otherwise
// surface as "no such table" log spam every tick.
func pluginEnabledChecker(ctx context.Context, store *plugins.Store, id string) func() bool {
	return func() bool {
		row, err := store.Get(ctx, id)
		return err == nil && row.Enabled
	}
}

// randomPassword returns a URL-safe base64 string of nBytes entropy
// (output length ≈ ceil(4n/3)). 24 bytes → 32 chars, ~192 bits entropy.
func randomPassword(nBytes int) (string, error) {
	b := make([]byte, nBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
