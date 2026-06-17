package sshaudit

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// Fail2banStatus is the live per-host fail2ban state. It is read fresh from
// the host on every request — there is no DB row backing it.
type Fail2banStatus struct {
	Installed       bool     `json:"installed"`
	Active          bool     `json:"active"`
	CurrentlyBanned int      `json:"currently_banned"`
	TotalBanned     int      `json:"total_banned"`
	BannedIPs       []string `json:"banned_ips"`
}

// fail2banStatusScript probes the host for fail2ban. It prints three
// well-known markers (INSTALLED=, ACTIVE=, then a JAIL block) so the parser
// has unambiguous fields regardless of distro. It always exits 0 — "not
// installed" is a valid answer, not an error.
const fail2banStatusScript = `
if command -v fail2ban-client >/dev/null 2>&1; then
  echo "INSTALLED=1"
else
  echo "INSTALLED=0"
  echo "ACTIVE=0"
  exit 0
fi
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet fail2ban; then
  echo "ACTIVE=1"
elif command -v rc-service >/dev/null 2>&1 && rc-service fail2ban status >/dev/null 2>&1; then
  echo "ACTIVE=1"
elif command -v service >/dev/null 2>&1 && service fail2ban status >/dev/null 2>&1; then
  echo "ACTIVE=1"
elif fail2ban-client ping >/dev/null 2>&1; then
  echo "ACTIVE=1"
else
  echo "ACTIVE=0"
fi
echo "JAIL_BEGIN"
fail2ban-client status sshd 2>/dev/null || true
echo "JAIL_END"
`

// fail2banEnableScript installs fail2ban if missing, writes the shepherd sshd
// jail, and enables+starts the service. It is intentionally robust across the
// common package managers and init systems.
const fail2banEnableScript = `set -e
export DEBIAN_FRONTEND=noninteractive
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq fail2ban
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y fail2ban
  elif command -v yum >/dev/null 2>&1; then
    yum install -y fail2ban
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache fail2ban
  else
    echo "no supported package manager (apt-get/dnf/yum/apk) found" >&2
    exit 1
  fi
fi
mkdir -p /etc/fail2ban/jail.d
cat > /etc/fail2ban/jail.d/shepherd-sshd.local <<'EOF'
[sshd]
enabled = true
maxretry = 5
findtime = 600
bantime = 3600
EOF
if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now fail2ban
  systemctl reload fail2ban 2>/dev/null || systemctl restart fail2ban
elif command -v rc-service >/dev/null 2>&1; then
  rc-update add fail2ban default 2>/dev/null || true
  rc-service fail2ban restart
elif command -v service >/dev/null 2>&1; then
  service fail2ban restart
else
  echo "no init system (systemctl/rc-service/service) found" >&2
  exit 1
fi
`

// fail2banDisableScript stops and disables the service but keeps the package
// and jail config so re-enabling is fast.
const fail2banDisableScript = `
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now fail2ban 2>/dev/null || true
elif command -v rc-service >/dev/null 2>&1; then
  rc-service fail2ban stop 2>/dev/null || true
  rc-update del fail2ban default 2>/dev/null || true
elif command -v service >/dev/null 2>&1; then
  service fail2ban stop 2>/dev/null || true
else
  echo "no init system (systemctl/rc-service/service) found" >&2
  exit 1
fi
`

// fail2banLiveStatus runs the probe script on the host and parses the result.
// Returns the not-installed zero status (not an error) when fail2ban is
// absent. A RunCmd/agent failure is surfaced as an error → 502 at the handler.
func fail2banLiveStatus(ctx context.Context, exec plugins.HostExec, serverID int64) (Fail2banStatus, error) {
	stdout, _, code, err := exec.RunCmd(ctx, serverID, "sh", "-c", fail2banStatusScript)
	if err != nil {
		return Fail2banStatus{}, err
	}
	if code != 0 {
		return Fail2banStatus{}, fmt.Errorf("fail2ban status probe exited %d on host", code)
	}
	installed, active, jail := splitStatusProbe(string(stdout))
	return parseFail2banStatus(installed, active, jail), nil
}

// fail2banApply enables or disables fail2ban on the host. enable=true installs
// (if needed) + starts; enable=false stops + disables, keeping the package.
func fail2banApply(ctx context.Context, exec plugins.HostExec, serverID int64, enable bool) error {
	script := fail2banDisableScript
	if enable {
		script = fail2banEnableScript
	}
	stdout, stderr, code, err := exec.RunCmd(ctx, serverID, "sh", "-c", script)
	if err != nil {
		return err
	}
	if code != 0 {
		msg := strings.TrimSpace(string(stderr))
		if msg == "" {
			msg = strings.TrimSpace(string(stdout))
		}
		if msg == "" {
			msg = fmt.Sprintf("fail2ban action exited %d on host", code)
		}
		return fmt.Errorf("fail2ban action failed: %s", msg)
	}
	return nil
}

// splitStatusProbe extracts the INSTALLED=/ACTIVE= flags and the jail block
// (everything between JAIL_BEGIN and JAIL_END) from the probe script output.
func splitStatusProbe(out string) (installed bool, active bool, jail string) {
	lines := strings.Split(out, "\n")
	var jailLines []string
	inJail := false
	for _, raw := range lines {
		line := strings.TrimRight(raw, "\r")
		switch {
		case line == "JAIL_BEGIN":
			inJail = true
		case line == "JAIL_END":
			inJail = false
		case inJail:
			jailLines = append(jailLines, line)
		case strings.HasPrefix(line, "INSTALLED="):
			installed = strings.TrimPrefix(line, "INSTALLED=") == "1"
		case strings.HasPrefix(line, "ACTIVE="):
			active = strings.TrimPrefix(line, "ACTIVE=") == "1"
		}
	}
	return installed, active, strings.Join(jailLines, "\n")
}

// parseFail2banStatus builds the status object from the probe flags and the
// raw `fail2ban-client status sshd` output. It is pure (no host calls) so it
// is trivially unit-testable. jailStatus is the tree-formatted block, e.g.:
//
//	Status for the jail: sshd
//	|- Filter
//	|  |- Currently failed: 2
//	|  |- Total failed:     9
//	|  `- File list:        /var/log/auth.log
//	`- Actions
//	   |- Currently banned: 3
//	   |- Total banned:     12
//	   `- Banned IP list:   1.2.3.4 5.6.7.8 9.9.9.9
//
// When the jail isn't running (or fail2ban isn't installed) the counts are 0
// and the IP list empty.
func parseFail2banStatus(installed bool, active bool, jailStatus string) Fail2banStatus {
	st := Fail2banStatus{
		Installed: installed,
		Active:    active,
		BannedIPs: []string{},
	}
	for _, raw := range strings.Split(jailStatus, "\n") {
		line := strings.TrimRight(raw, "\r")
		if v, ok := fieldValue(line, "Currently banned:"); ok {
			st.CurrentlyBanned = atoiSafe(v)
		}
		if v, ok := fieldValue(line, "Total banned:"); ok {
			st.TotalBanned = atoiSafe(v)
		}
		if v, ok := fieldValue(line, "Banned IP list:"); ok {
			st.BannedIPs = fieldsNonEmpty(v)
		}
	}
	return st
}

// fieldValue finds label within a tree-formatted fail2ban line and returns the
// trimmed remainder after it. The leading "|- "/"`- "/indent decoration is
// ignored because we anchor on the label text.
func fieldValue(line, label string) (string, bool) {
	idx := strings.Index(line, label)
	if idx < 0 {
		return "", false
	}
	return strings.TrimSpace(line[idx+len(label):]), true
}

// fieldsNonEmpty splits on whitespace and drops empties — used for the
// space-separated banned IP list (which is empty when nothing is banned).
func fieldsNonEmpty(s string) []string {
	f := strings.Fields(s)
	if f == nil {
		return []string{}
	}
	return f
}

// atoiSafe parses an integer, returning 0 on any parse failure.
func atoiSafe(s string) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return 0
	}
	return n
}
