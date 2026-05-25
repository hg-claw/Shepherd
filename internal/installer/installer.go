package installer

import (
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// SSHCredentials holds the one-shot install credentials. They are NEVER persisted.
type SSHCredentials struct {
	Host       string
	Port       int
	User       string
	Password   string // either Password or PrivateKey, not both
	PrivateKey []byte
}

type Installer struct {
	Distribution Distribution
	// LogSink receives streamed install_log; the install state machine bridges it to DB.
	// It MUST be safe for concurrent calls.
	LogSink func(line string)
	// SSHTimeout for connect + each command. Default 30s.
	SSHTimeout time.Duration
}

type InstallParams struct {
	Creds           SSHCredentials
	Arch            string // "amd64" | "arm64"
	ServerURL       string // base URL the agent will dial back to (incl. scheme)
	EnrollmentToken string
}

// SetLogSink lets the install state machine inject a per-request log sink.
func (in *Installer) SetLogSink(f func(string)) { in.LogSink = f }

// Run performs the install. It returns when the systemd service has been started.
// All progress is streamed to LogSink; fatal errors return as well.
func (in *Installer) Run(ctx context.Context, p InstallParams) error {
	if in.SSHTimeout == 0 {
		in.SSHTimeout = 30 * time.Second
	}
	in.log("connecting to %s@%s:%d", p.Creds.User, p.Creds.Host, p.Creds.Port)

	auth, err := buildAuth(p.Creds)
	if err != nil {
		return err
	}
	cfg := &ssh.ClientConfig{
		User:            p.Creds.User,
		Auth:            auth,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // TODO: TOFU before exposing publicly
		Timeout:         in.SSHTimeout,
	}
	addr := net.JoinHostPort(p.Creds.Host, fmt.Sprintf("%d", p.Creds.Port))
	c, err := ssh.Dial("tcp", addr, cfg)
	if err != nil {
		return fmt.Errorf("ssh dial: %w", err)
	}
	defer func() { _ = c.Close() }()
	in.log("connected")

	if err := in.runCmd(c, `mkdir -p /etc/shepherd && chmod 0750 /etc/shepherd`); err != nil {
		return err
	}

	data, snippet, streamed, err := in.Distribution.Provide(p.Arch)
	if err != nil {
		return fmt.Errorf("distribution: %w", err)
	}
	if streamed {
		if err := in.streamFile(c, data, "/usr/local/bin/shepherd-agent", 0o755); err != nil {
			return err
		}
	} else {
		if err := in.runCmd(c, snippet); err != nil {
			return err
		}
	}
	in.log("agent binary in place")

	envContent := fmt.Sprintf("SERVER_URL=%s\nENROLLMENT_TOKEN=%s\n", p.ServerURL, p.EnrollmentToken)
	if err := in.streamFile(c, strings.NewReader(envContent), "/etc/shepherd/agent.env", 0o600); err != nil {
		return err
	}

	unit := `[Unit]
Description=Shepherd agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/shepherd/agent.env
ExecStart=/usr/local/bin/shepherd-agent
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
`
	if err := in.streamFile(c, strings.NewReader(unit), "/etc/systemd/system/shepherd-agent.service", 0o644); err != nil {
		return err
	}

	for _, cmd := range []string{
		`systemctl daemon-reload`,
		`systemctl enable shepherd-agent`,
		`systemctl restart shepherd-agent`,
	} {
		if err := in.runCmd(c, cmd); err != nil {
			return err
		}
	}
	in.log("service started")
	return nil
}

func (in *Installer) log(format string, args ...any) {
	if in.LogSink != nil {
		in.LogSink(fmt.Sprintf(format, args...))
	}
}

func (in *Installer) runCmd(c *ssh.Client, cmd string) error {
	sess, err := c.NewSession()
	if err != nil {
		return err
	}
	defer func() { _ = sess.Close() }()
	in.log("$ %s", cmd)
	out, err := sess.CombinedOutput(cmd)
	if len(out) > 0 {
		in.log("%s", strings.TrimRight(string(out), "\n"))
	}
	if err != nil {
		return fmt.Errorf("cmd %q failed: %w", cmd, err)
	}
	return nil
}

// streamFile writes content to remotePath via `cat > file && chmod` over a single SSH session.
// Avoids needing scp on the target.
func (in *Installer) streamFile(c *ssh.Client, src io.Reader, remotePath string, mode int) error {
	sess, err := c.NewSession()
	if err != nil {
		return err
	}
	defer func() { _ = sess.Close() }()
	stdin, err := sess.StdinPipe()
	if err != nil {
		return err
	}
	cmd := fmt.Sprintf("umask 077 && cat > %q && chmod %o %q", remotePath, mode, remotePath)
	if err := sess.Start(cmd); err != nil {
		return err
	}
	if _, err := io.Copy(stdin, src); err != nil {
		return err
	}
	if err := stdin.Close(); err != nil {
		return err
	}
	if err := sess.Wait(); err != nil {
		return fmt.Errorf("write %s: %w", remotePath, err)
	}
	in.log("wrote %s", remotePath)
	return nil
}

func buildAuth(c SSHCredentials) ([]ssh.AuthMethod, error) {
	if len(c.PrivateKey) > 0 {
		signer, err := ssh.ParsePrivateKey(c.PrivateKey)
		if err != nil {
			return nil, fmt.Errorf("parse private key: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil
	}
	if c.Password != "" {
		// Two methods, tried in order. Many sshd configurations advertise
		// only "keyboard-interactive" for password auth (especially when
		// PAM is in the loop) — the raw "password" method then gets a
		// "no supported methods remain" rejection even when the password
		// itself is correct. The KeyboardInteractive responder answers
		// every server prompt with the same password, which is the
		// standard CLI-equivalent of pasting it into an `ssh user@host`
		// prompt and works for the PAM case.
		kbAnswer := func(_, _ string, questions []string, _ []bool) ([]string, error) {
			answers := make([]string, len(questions))
			for i := range questions {
				answers[i] = c.Password
			}
			return answers, nil
		}
		return []ssh.AuthMethod{
			ssh.Password(c.Password),
			ssh.KeyboardInteractive(kbAnswer),
		}, nil
	}
	return nil, fmt.Errorf("no ssh credentials provided")
}
