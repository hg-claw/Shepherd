package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os/signal"
	"syscall"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/api"
	"github.com/hg-claw/Shepherd/internal/auth"
	"github.com/hg-claw/Shepherd/internal/config"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/installer"
	"github.com/hg-claw/Shepherd/internal/serversvc"
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
	defer d.Close()
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
	settings := &api.SettingsAPI{Settings: settingsStore}
	public := &api.PublicAPI{Servers: serverSvc, Settings: settingsStore, Query: tQuery, Hub: hub}
	agentAPI := &api.AgentAPI{Agents: agentSvc, Hub: hub, OnFrame: tIngest.HandleFrame}

	router := api.NewRouter(authAPI, authH.RequireAdmin, servers, settings, public, agentAPI, shepweb.Handler())

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
