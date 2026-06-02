package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, err := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	if err := shepdb.Migrate(d, shepdb.DriverSQLite); err != nil {
		t.Fatal(err)
	}
	return &Store{DB: d}
}

func TestAdminCreateAndVerify(t *testing.T) {
	s := newTestStore(t)
	a, err := s.CreateAdmin(context.Background(), "alice", "hunter2")
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.FindAdminByUsername(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != a.ID {
		t.Errorf("id mismatch")
	}
	if !VerifyPassword(got.PasswordHash, "hunter2") {
		t.Error("password should verify")
	}
	if VerifyPassword(got.PasswordHash, "wrong") {
		t.Error("wrong password should not verify")
	}
}

func TestSessionRoundTrip(t *testing.T) {
	s := newTestStore(t)
	a, _ := s.CreateAdmin(context.Background(), "bob", "pw")
	sess, err := s.IssueSession(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, got, err := s.LookupSession(context.Background(), sess.Token)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != a.ID {
		t.Error("id mismatch")
	}
	if err := s.RevokeSession(context.Background(), sess.Token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.LookupSession(context.Background(), sess.Token); err == nil {
		t.Fatal("want error")
	}
}

func TestRequireAdminRejectsAnonymous(t *testing.T) {
	s := newTestStore(t)
	h := &Handler{Store: s, Secure: false}
	called := false
	final := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true })
	srv := h.RequireAdmin(final)

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	srv.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("status=%d want 401", w.Code)
	}
	if called {
		t.Error("handler should not have been called")
	}
}

func TestRequireAdmin_BearerToken(t *testing.T) {
	s := newTestStore(t)
	a, err := s.CreateAdmin(context.Background(), "bob", "pw")
	if err != nil {
		t.Fatal(err)
	}
	sess, err := s.IssueSession(context.Background(), a.ID)
	if err != nil {
		t.Fatal(err)
	}
	h := &Handler{Store: s, Secure: false}
	called := false
	srv := h.RequireAdmin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if adm, ok := AdminFromContext(r.Context()); !ok || adm.ID != a.ID {
			t.Errorf("admin not in context")
		}
	}))

	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	srv.ServeHTTP(w, r)
	if w.Code != 200 || !called {
		t.Fatalf("bearer should pass: code=%d called=%v", w.Code, called)
	}

	called = false
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: h.CookieName(), Value: "garbage"})
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	srv.ServeHTTP(w, r)
	if w.Code != 200 || !called {
		t.Fatalf("valid bearer + bad cookie should pass: code=%d", w.Code)
	}

	if err := s.RevokeSession(context.Background(), sess.Token); err != nil {
		t.Fatal(err)
	}
	called = false
	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer "+sess.Token)
	srv.ServeHTTP(w, r)
	if w.Code != 401 || called {
		t.Fatalf("revoked bearer should 401: code=%d called=%v", w.Code, called)
	}

	w = httptest.NewRecorder()
	r = httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer ")
	srv.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("empty bearer should 401: code=%d", w.Code)
	}
}

func TestBearerToken(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.Header.Set("Authorization", "Bearer abc123")
	if got := BearerToken(r); got != "abc123" {
		t.Fatalf("got %q", got)
	}
	r2 := httptest.NewRequest("GET", "/", nil)
	r2.Header.Set("Authorization", "bearer xyz")
	if got := BearerToken(r2); got != "xyz" {
		t.Fatalf("case-insensitive: got %q", got)
	}
	if got := BearerToken(httptest.NewRequest("GET", "/", nil)); got != "" {
		t.Fatalf("no header: got %q", got)
	}
	r3 := httptest.NewRequest("GET", "/", nil)
	r3.Header.Set("Authorization", "Basic abc")
	if got := BearerToken(r3); got != "" {
		t.Fatalf("non-bearer scheme: got %q", got)
	}
}
