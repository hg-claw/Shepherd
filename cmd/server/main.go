package main

import (
	"context"
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
	_ "github.com/hg-claw/Shepherd/internal/plugins/cloudflare"       // registers via init()
	xrayplugin "github.com/hg-claw/Shepherd/internal/plugins/xray" // registers via init() + Migrate0003
	"github.com/hg-claw/Shepherd/internal/ptysvc"
	"github.com/hg-claw/Shepherd/internal/scriptsvc"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
	shepweb "github.com/hg-claw/Shepherd/internal/web"
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

	if cfg.InitialAdminUsername != "" && cfg.InitialAdminPassword != "" {
		var n int
		_ = d.Get(&n, "SELECT COUNT(*) FROM admins")
		if n == 0 {
			if _, err := authStore.CreateAdmin(rootCtx, cfg.InitialAdminUsername, cfg.InitialAdminPassword); err != nil {
				log.Fatalf("create initial admin: %v", err)
			}
			log.Printf("created initial admin %q", cfg.InitialAdminUsername)
		}
	}

	serverSvc := &serversvc.Service{DB: d}
	settingsStore := &serversvc.SettingsStore{DB: d}
	agentSvc := &agentsvc.Service{DB: d, AutoRecoverKey: cfg.AutoRecoverKey}
	hub := agentsvc.NewHub()
	tQuery := &telemetrysvc.Query{DB: d}
	tIngest := &telemetrysvc.Ingest{DB: d}

	reg := sessionmux.New()
	auditW := &audit.Writer{DB: d, Now: time.Now}

	ptyService := &ptysvc.Service{
		DB:            d,
		Hub:           hub,
		Reg:           reg,
		Audit:         auditW,
		Now:           time.Now,
		RecordingsDir: filepath.Join(filepath.Dir(cfg.DBDSN), "pty-recordings"),
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
	go (&telemetrysvc.Retention{DB: d, Settings: settingsStore}).Run(rootCtx)

	authAPI := &api.AuthAPI{Auth: authH}
	servers := &api.ServersAPI{
		Servers: serverSvc, Settings: settingsStore, Query: tQuery, Hub: hub,
		InstallManager: installMgr, Tokens: agentSvc,
	}
	settings := &api.SettingsAPI{
		Settings:        settingsStore,
		OnSandboxChange: sandboxPusher.PushAll,
	}
	public := &api.PublicAPI{Servers: serverSvc, Settings: settingsStore, Query: tQuery, Hub: hub}
	agentAPI := &api.AgentAPI{
		Agents:            agentSvc,
		Hub:               hub,
		OnFrame:           tIngest.HandleFrame,
		Reg:               reg,
		OnAgentDisconnect: ptyService.AgentDisconnected,
		PushSandbox:       func(serverID int64) { sandboxPusher.PushOne(rootCtx, serverID) },
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

	// HubHostExec wires plugins.HostExec to the project's filesvc (file push)
	// and the agent WS hub (one-shot PTY exec via sessionmux). No DB row is
	// written for plugin-initiated exec; sessions are ephemeral.
	hostExec := &plugins.HubHostExec{Hub: hub, Files: filesService, Reg: reg}
	pluginStore := &plugins.Store{DB: d, Now: time.Now}
	pluginsDeps := plugins.Deps{
		DB:       d,
		DataDir:  filepath.Join(filepath.Dir(cfg.DBDSN), "plugins"),
		HostExec: hostExec,
		Now:      time.Now,
	}
	pluginsAPI := &api.PluginsAPI{
		Store: pluginStore,
		Deps:  pluginsDeps,
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
		if err := plugins.RunPluginMigrations(rootCtx, d, p.Meta().ID, p.Migrations()); err != nil {
			log.Printf("plugin %s: boot migrate: %v", p.Meta().ID, err)
		}
		if p.Meta().ID == "xray" {
			if err := xrayplugin.Migrate0003(rootCtx, d); err != nil {
				log.Printf("xray.Migrate0003: %v", err)
				// continue — don't crash boot
			}
		}
	}

	eventsAPI := &api.PluginEventsAPI{DB: d}
	logsAPI := &api.PluginLogsAPI{HostExec: hostExec, Deps: pluginsDeps}

	router := api.NewRouter(authAPI, authH.RequireAdmin,
		servers, settings, public, agentAPI,
		consoleAPI, scriptsAPI, filesAPI, auditAPI, recAPI,
		shepweb.Handler()).
		WithPlugins(pluginsAPI, eventsAPI, logsAPI)

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
