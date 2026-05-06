package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/hg-claw/Shepherd/internal/agentsvc"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/serversvc"
	"github.com/hg-claw/Shepherd/internal/telemetrysvc"
)

func TestPublic_HidesPrivateAndExposesAlias(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)

	svc := &serversvc.Service{DB: d}
	settings := &serversvc.SettingsStore{DB: d}
	q := &telemetrysvc.Query{DB: d}
	hub := agentsvc.NewHub()
	api := &PublicAPI{Servers: svc, Settings: settings, Query: q, Hub: hub}

	a, _ := svc.Create(context.Background(), serversvc.CreateInput{Name: "internal-name-A", PublicAlias: "HK-1", ShowOnPublic: true, CountryCode: "HK"})
	_, _ = svc.Create(context.Background(), serversvc.CreateInput{Name: "internal-name-B", ShowOnPublic: false})

	ing := &telemetrysvc.Ingest{DB: d}
	_ = ing.WriteSample(context.Background(), a.ID, agentapi.Telemetry{TS: time.Now().UTC(), CPUPct: 5, MemUsed: 1, MemTotal: 2})
	_, _ = d.Exec("UPDATE servers SET agent_last_seen=$1 WHERE id=$2", time.Now().UTC(), a.ID)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/api/public/servers", nil)
	api.Servers_ListPublic(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	var cards []publicCard
	_ = json.Unmarshal(w.Body.Bytes(), &cards)
	if len(cards) != 1 || cards[0].Alias != "HK-1" || cards[0].CountryCode != "HK" {
		t.Fatalf("cards=%+v", cards)
	}
	if !cards[0].Online {
		t.Error("should be online")
	}
	body := w.Body.String()
	for _, leak := range []string{"internal-name-A", "ssh_user", "agent_fingerprint"} {
		if strings.Contains(body, leak) {
			t.Errorf("public leaked %q", leak)
		}
	}
}
