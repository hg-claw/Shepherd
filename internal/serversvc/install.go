package serversvc

import (
	"context"
	"runtime"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/installer"
)

// Installer is the subset of *installer.Installer the state machine needs.
type Installer interface {
	Run(ctx context.Context, p installer.InstallParams) error
}

// AgentTokenIssuer issues a one-shot enrollment token bound to a server.
type AgentTokenIssuer interface {
	IssueEnrollmentToken(ctx context.Context, serverID int64) (string, time.Time, error)
}

type InstallManager struct {
	Service         *Service
	Installer       Installer
	Tokens          AgentTokenIssuer
	ServerURL       string          // base URL agent will dial back to
	WatchdogTimeout time.Duration   // default 10m
	Ctx             context.Context // optional; defaults to context.Background() — pass server's rootCtx for graceful shutdown
}

type InstallRequest struct {
	Server *Server
	Creds  installer.SSHCredentials
	Arch   string // "amd64" | "arm64"; defaults from server fields if empty
}

// Start launches an install in a background goroutine and returns immediately.
// Updates the server row's install_stage / install_log / install_error as it goes.
// Idempotency: caller is responsible for checking the row isn't already in 'installing'.
func (m *InstallManager) Start(req InstallRequest) {
	ctx := m.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	go m.run(ctx, req)
}

func (m *InstallManager) run(ctx context.Context, req InstallRequest) {
	sid := req.Server.ID
	now := time.Now().UTC()
	_, _ = m.Service.DB.ExecContext(ctx,
		"UPDATE servers SET install_stage='installing', install_started_at=$1, install_log='', install_error=NULL WHERE id=$2",
		now, sid)

	tok, _, err := m.Tokens.IssueEnrollmentToken(ctx, sid)
	if err != nil {
		m.fail(ctx, sid, "enrollment token: "+err.Error())
		return
	}

	arch := strings.ToLower(strings.TrimSpace(req.Arch))
	if arch == "" {
		arch = runtime.GOARCH
		if arch != "amd64" && arch != "arm64" {
			arch = "amd64"
		}
	}

	sink := func(line string) {
		m.Service.appendInstallLog(ctx, sid, line)
	}
	type sinkSetter interface{ SetLogSink(func(string)) }
	if s, ok := m.Installer.(sinkSetter); ok {
		s.SetLogSink(sink)
	}

	if err := m.Installer.Run(ctx, installer.InstallParams{
		Creds:           req.Creds,
		Arch:            arch,
		ServerURL:       m.ServerURL,
		EnrollmentToken: tok,
	}); err != nil {
		m.fail(ctx, sid, err.Error())
		return
	}

	if err := m.Service.SetInstallStage(ctx, sid, "done", nil); err != nil {
		m.fail(ctx, sid, "finalize: "+err.Error())
		return
	}
}

func (m *InstallManager) fail(ctx context.Context, sid int64, msg string) {
	_ = m.Service.SetInstallStage(ctx, sid, "failed", &msg)
}

// SweepStuck marks any server stuck in 'installing' for longer than WatchdogTimeout as failed.
// Run once at server startup so a crashed install doesn't leave UI hanging.
func (m *InstallManager) SweepStuck(ctx context.Context) error {
	timeout := m.WatchdogTimeout
	if timeout == 0 {
		timeout = 10 * time.Minute
	}
	cutoff := time.Now().UTC().Add(-timeout)
	_, err := m.Service.DB.ExecContext(ctx,
		`UPDATE servers SET install_stage='failed', install_error='install watchdog: stuck > timeout'
		 WHERE install_stage='installing' AND install_started_at < $1`, cutoff)
	return err
}
