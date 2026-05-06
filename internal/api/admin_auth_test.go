package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/hg-claw/Shepherd/internal/auth"
	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newAuthAPI(t *testing.T) (*AuthAPI, *auth.Store) {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	store := &auth.Store{DB: d}
	_, _ = store.CreateAdmin(context.Background(), "alice", "hunter2")
	h := &auth.Handler{Store: store, Secure: false}
	return &AuthAPI{Auth: h}, store
}

func TestLogin_OK(t *testing.T) {
	a, _ := newAuthAPI(t)
	body, _ := json.Marshal(loginReq{Username: "alice", Password: "hunter2"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(body))
	a.Login(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d", w.Code)
	}
	if len(w.Result().Cookies()) == 0 {
		t.Fatal("missing session cookie")
	}
}

func TestLogin_BadCreds(t *testing.T) {
	a, _ := newAuthAPI(t)
	body, _ := json.Marshal(loginReq{Username: "alice", Password: "wrong"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/api/login", bytes.NewReader(body))
	a.Login(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want 401", w.Code)
	}
}
