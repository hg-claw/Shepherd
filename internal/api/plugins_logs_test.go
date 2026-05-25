package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/plugins"
)

type fakeStreamer struct {
	hostP
}

func (fakeStreamer) LogStreamCommand(_ context.Context, _ plugins.Deps, _ int64) (string, []string, error) {
	return "journalctl", []string{"-u", "shepherd-xray", "-f"}, nil
}

type fakeExec struct {
	lines []string
}

func (f *fakeExec) PushFile(context.Context, int64, string, uint32, []byte) error {
	return nil
}
func (f *fakeExec) FetchURL(context.Context, int64, agentapi.FileFetch) error { return nil }
func (f *fakeExec) RunCmd(context.Context, int64, string, ...string) ([]byte, []byte, int, error) {
	return nil, nil, 0, nil
}
func (f *fakeExec) StreamCmd(_ context.Context, _ int64, _ string, _ []string, onLine func(string)) error {
	for _, l := range f.lines {
		onLine(l)
	}
	return nil
}

func TestPluginLogsWS_EmitsLineEnvelopes(t *testing.T) {
	plugins.ResetRegistryForTestPublic()
	plugins.Register(fakeStreamer{hostP: hostP{plainP: plainP{id: "fs"}}})
	exec := &fakeExec{lines: []string{"hello", "world"}}
	api := &PluginLogsAPI{HostExec: exec, Deps: plugins.Deps{}}

	server := httptest.NewServer(http.HandlerFunc(api.AttachWS))
	defer server.Close()
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/?id=fs&server_id=1"
	parsed, _ := url.Parse(wsURL)
	conn, _, err := websocket.DefaultDialer.Dial(parsed.String(), nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	got := []string{}
	for i := 0; i < 2; i++ {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		got = append(got, string(msg))
	}
	for _, line := range []string{"hello", "world"} {
		found := false
		for _, m := range got {
			if strings.Contains(m, `"line":"`+line+`"`) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("expected line %q in messages %v", line, got)
		}
	}
}
