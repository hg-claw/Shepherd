package api

import (
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/plugins"
	"github.com/hg-claw/Shepherd/internal/plugins/subgen"
)

func newSubgenAPI(t *testing.T) (*SubgenAPI, *subgen.Store) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "s.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { _ = d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	_ = plugins.RunPluginMigrations(context.Background(), d, "subgen", subgen.LoadMigrationsForTest(shepdb.DriverSQLite))
	st := &subgen.Store{DB: d, Now: time.Now}
	svc := &subgen.Service{Store: st, Now: time.Now}
	api := &SubgenAPI{Service: svc}
	api.InitRateLimit(60, time.Minute)
	return api, st
}

func TestSubgenPublic_TokenAuthAndTarget(t *testing.T) {
	api, st := newSubgenAPI(t)
	ctx := context.Background()
	tid, _ := st.CreateTemplate(ctx, "t", false, `{"final":"PROXY"}`)
	sub, _ := st.CreateSubscription(ctx, "s", tid)

	r := httptest.NewRequest("GET", "/sub/"+sub.Token+"?target=clash", nil)
	r.SetPathValue("token", sub.Token)
	w := httptest.NewRecorder()
	api.GetSubscription(w, r)
	if w.Code != 400 {
		t.Fatalf("bad target: %d", w.Code)
	}

	r = httptest.NewRequest("GET", "/sub/nope?target=surge", nil)
	r.SetPathValue("token", "nope")
	w = httptest.NewRecorder()
	api.GetSubscription(w, r)
	if w.Code != 404 {
		t.Fatalf("unknown token: %d", w.Code)
	}

	r = httptest.NewRequest("GET", "/sub/"+sub.Token+"?target=surge", nil)
	r.SetPathValue("token", sub.Token)
	w = httptest.NewRecorder()
	api.GetSubscription(w, r)
	if w.Code != 200 || w.Header().Get("Content-Type") != "text/plain; charset=utf-8" {
		t.Fatalf("valid: %d %s", w.Code, w.Header().Get("Content-Type"))
	}
}
