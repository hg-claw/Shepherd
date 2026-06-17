package sshaudit

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

// ── pure parser tests ──────────────────────────────────────────────────────

// A real `fail2ban-client status sshd` block.
const sampleJailStatus = `Status for the jail: sshd
|- Filter
|  |- Currently failed: 2
|  |- Total failed:     9
|  ` + "`" + `- File list:        /var/log/auth.log
` + "`" + `- Actions
   |- Currently banned: 3
   |- Total banned:     12
   ` + "`" + `- Banned IP list:   1.2.3.4 5.6.7.8 9.9.9.9`

func TestParseFail2banStatus_RealOutput(t *testing.T) {
	st := parseFail2banStatus(true, true, sampleJailStatus)
	if !st.Installed || !st.Active {
		t.Errorf("installed/active flags: %+v", st)
	}
	if st.CurrentlyBanned != 3 {
		t.Errorf("currently_banned=%d want 3", st.CurrentlyBanned)
	}
	if st.TotalBanned != 12 {
		t.Errorf("total_banned=%d want 12", st.TotalBanned)
	}
	want := []string{"1.2.3.4", "5.6.7.8", "9.9.9.9"}
	if len(st.BannedIPs) != len(want) {
		t.Fatalf("banned_ips=%v want %v", st.BannedIPs, want)
	}
	for i := range want {
		if st.BannedIPs[i] != want[i] {
			t.Errorf("banned_ips[%d]=%q want %q", i, st.BannedIPs[i], want[i])
		}
	}
}

func TestParseFail2banStatus_EmptyJail(t *testing.T) {
	// Installed + active but no bans yet → zeros + empty (non-nil) list.
	jail := `Status for the jail: sshd
|- Filter
|  |- Currently failed: 0
|  |- Total failed:     0
` + "`" + `- Actions
   |- Currently banned: 0
   |- Total banned:     0
   ` + "`" + `- Banned IP list:`
	st := parseFail2banStatus(true, true, jail)
	if st.CurrentlyBanned != 0 || st.TotalBanned != 0 {
		t.Errorf("empty jail counts: %+v", st)
	}
	if st.BannedIPs == nil || len(st.BannedIPs) != 0 {
		t.Errorf("banned_ips=%#v want empty non-nil slice", st.BannedIPs)
	}
}

func TestParseFail2banStatus_NotInstalled(t *testing.T) {
	st := parseFail2banStatus(false, false, "")
	if st.Installed || st.Active {
		t.Errorf("not-installed flags: %+v", st)
	}
	if st.CurrentlyBanned != 0 || st.TotalBanned != 0 {
		t.Errorf("not-installed counts: %+v", st)
	}
	if st.BannedIPs == nil || len(st.BannedIPs) != 0 {
		t.Errorf("not-installed banned_ips=%#v want empty non-nil slice", st.BannedIPs)
	}
}

func TestSplitStatusProbe(t *testing.T) {
	out := "INSTALLED=1\nACTIVE=1\nJAIL_BEGIN\nStatus for the jail: sshd\n|- Currently banned: 1\nJAIL_END\n"
	installed, active, jail := splitStatusProbe(out)
	if !installed || !active {
		t.Errorf("flags installed=%v active=%v want true/true", installed, active)
	}
	if !strings.Contains(jail, "Currently banned: 1") || strings.Contains(jail, "INSTALLED") {
		t.Errorf("jail block leaked or missing: %q", jail)
	}
}

// ── route tests with a scripted fake HostExec ──────────────────────────────

// f2bExec answers the `sh -c <script>` calls. It distinguishes the status
// probe from the apply script by looking for the JAIL_BEGIN marker, and
// records every command for assertions.
type f2bExec struct {
	statusOut  string // returned for the status probe script
	statusCode int
	statusErr  error
	applyCode  int
	applyErr   error
	cmds       [][]string
}

func (f *f2bExec) PushFile(context.Context, int64, string, uint32, []byte) error { return nil }
func (f *f2bExec) FetchURL(context.Context, int64, agentapi.FileFetch) error     { return nil }
func (f *f2bExec) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}

func (f *f2bExec) RunCmd(_ context.Context, _ int64, name string, args ...string) ([]byte, []byte, int, error) {
	f.cmds = append(f.cmds, append([]string{name}, args...))
	script := ""
	if name == "sh" && len(args) == 2 && args[0] == "-c" {
		script = args[1]
	}
	if strings.Contains(script, "JAIL_BEGIN") {
		return []byte(f.statusOut), nil, f.statusCode, f.statusErr
	}
	// apply (enable/disable) script
	return nil, nil, f.applyCode, f.applyErr
}

// ranScript reports whether any recorded `sh -c` script contains needle.
func (f *f2bExec) ranScript(needle string) bool {
	for _, c := range f.cmds {
		if len(c) == 3 && c[0] == "sh" && c[1] == "-c" && strings.Contains(c[2], needle) {
			return true
		}
	}
	return false
}

func setupF2B(t *testing.T, exec *f2bExec) *collectMux {
	t.Helper()
	now := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)
	db := openTestDB(t)
	p := New()
	mux := &collectMux{}
	p.RegisterRoutes(mux, plugins.Deps{DB: db, HostExec: exec, Now: fixedNow(now)})
	return mux
}

func TestFail2ban_GetStatus_Parsed(t *testing.T) {
	exec := &f2bExec{statusOut: "INSTALLED=1\nACTIVE=1\nJAIL_BEGIN\n" + sampleJailStatus + "\nJAIL_END\n"}
	mux := setupF2B(t, exec)

	req := httptest.NewRequest("GET", "/hosts/1/fail2ban", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/fail2ban"](w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var st Fail2banStatus
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if !st.Installed || !st.Active || st.CurrentlyBanned != 3 || st.TotalBanned != 12 {
		t.Errorf("status=%+v", st)
	}
	if len(st.BannedIPs) != 3 || st.BannedIPs[0] != "1.2.3.4" {
		t.Errorf("banned_ips=%v", st.BannedIPs)
	}
}

func TestFail2ban_GetStatus_NotInstalled(t *testing.T) {
	exec := &f2bExec{statusOut: "INSTALLED=0\nACTIVE=0\n"}
	mux := setupF2B(t, exec)

	req := httptest.NewRequest("GET", "/hosts/1/fail2ban", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/fail2ban"](w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var st Fail2banStatus
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if st.Installed || st.Active || st.CurrentlyBanned != 0 || st.TotalBanned != 0 || len(st.BannedIPs) != 0 {
		t.Errorf("not-installed status=%+v want all-zero", st)
	}
}

func TestFail2ban_GetStatus_502OnHostError(t *testing.T) {
	exec := &f2bExec{statusErr: context.DeadlineExceeded}
	mux := setupF2B(t, exec)
	req := httptest.NewRequest("GET", "/hosts/1/fail2ban", nil)
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["GET /hosts/{server_id}/fail2ban"](w, req)
	if w.Code != 502 {
		t.Errorf("status=%d want 502", w.Code)
	}
}

func TestFail2ban_PostEnable_RunsInstallScript(t *testing.T) {
	// After enable, the re-query reports installed+active.
	exec := &f2bExec{statusOut: "INSTALLED=1\nACTIVE=1\nJAIL_BEGIN\n" + sampleJailStatus + "\nJAIL_END\n"}
	mux := setupF2B(t, exec)

	req := httptest.NewRequest("POST", "/hosts/1/fail2ban", strings.NewReader(`{"enabled":true}`))
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["POST /hosts/{server_id}/fail2ban"](w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	// The enable script must have run (writes the shepherd jail config).
	if !exec.ranScript("/etc/fail2ban/jail.d/shepherd-sshd.local") {
		t.Errorf("enable script did not write the shepherd jail; cmds=%v", exec.cmds)
	}
	if !exec.ranScript("systemctl enable --now fail2ban") {
		t.Errorf("enable script did not enable the service; cmds=%v", exec.cmds)
	}
	// Response is the re-queried status.
	var st Fail2banStatus
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if !st.Installed || !st.Active || st.CurrentlyBanned != 3 {
		t.Errorf("post-enable status=%+v", st)
	}
}

func TestFail2ban_PostDisable_RunsDisableScript(t *testing.T) {
	// After disable, the re-query reports installed but inactive.
	exec := &f2bExec{statusOut: "INSTALLED=1\nACTIVE=0\nJAIL_BEGIN\nJAIL_END\n"}
	mux := setupF2B(t, exec)

	req := httptest.NewRequest("POST", "/hosts/1/fail2ban", strings.NewReader(`{"enabled":false}`))
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["POST /hosts/{server_id}/fail2ban"](w, req)
	if w.Code != 200 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	if !exec.ranScript("systemctl disable --now fail2ban") {
		t.Errorf("disable script did not disable the service; cmds=%v", exec.cmds)
	}
	// Disable must NOT install/remove the package or rewrite the jail.
	if exec.ranScript("apt-get install") || exec.ranScript("shepherd-sshd.local") {
		t.Errorf("disable script touched package/jail config; cmds=%v", exec.cmds)
	}
	var st Fail2banStatus
	_ = json.Unmarshal(w.Body.Bytes(), &st)
	if !st.Installed || st.Active {
		t.Errorf("post-disable status=%+v want installed+inactive", st)
	}
}

func TestFail2ban_PostEnable_502OnHostError(t *testing.T) {
	exec := &f2bExec{applyErr: context.DeadlineExceeded}
	mux := setupF2B(t, exec)
	req := httptest.NewRequest("POST", "/hosts/1/fail2ban", strings.NewReader(`{"enabled":true}`))
	req.SetPathValue("server_id", "1")
	w := httptest.NewRecorder()
	mux.h["POST /hosts/{server_id}/fail2ban"](w, req)
	if w.Code != 502 {
		t.Errorf("status=%d want 502", w.Code)
	}
}
