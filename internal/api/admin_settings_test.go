package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"path/filepath"
	"testing"

	shepdb "github.com/hg-claw/Shepherd/internal/db"
	"github.com/hg-claw/Shepherd/internal/serversvc"
)

func TestSettingsPatch_RejectsUnknownKeys(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	api := &SettingsAPI{Settings: &serversvc.SettingsStore{DB: d}}

	body, _ := json.Marshal(map[string]string{"hacked_key": "value"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("PATCH", "/api/settings", bytes.NewReader(body))
	api.Patch(w, r)
	if w.Code != 400 {
		t.Fatalf("status=%d want 400", w.Code)
	}

	// Confirm hacked_key was NOT inserted
	var v string
	err := d.Get(&v, "SELECT value FROM settings WHERE key='hacked_key'")
	if err == nil {
		t.Errorf("hacked_key was persisted: %q", v)
	}
}

func TestSettingsPatch_AcceptsKnownKey(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "t.db") + "?_fk=1"
	d, _ := shepdb.Open(context.Background(), shepdb.Config{Driver: shepdb.DriverSQLite, DSN: dsn})
	t.Cleanup(func() { d.Close() })
	_ = shepdb.Migrate(d, shepdb.DriverSQLite)
	api := &SettingsAPI{Settings: &serversvc.SettingsStore{DB: d}}

	body, _ := json.Marshal(map[string]string{"public_display_mode": "raw"})
	w := httptest.NewRecorder()
	r := httptest.NewRequest("PATCH", "/api/settings", bytes.NewReader(body))
	api.Patch(w, r)
	if w.Code != 200 {
		t.Fatalf("status=%d want 200", w.Code)
	}
	var v string
	d.Get(&v, "SELECT value FROM settings WHERE key='public_display_mode'")
	if v != "raw" {
		t.Errorf("got %q", v)
	}
}
