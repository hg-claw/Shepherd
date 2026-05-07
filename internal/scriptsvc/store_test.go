package scriptsvc

import (
	"context"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/db"
)

func TestStore_CRUD(t *testing.T) {
	d, _ := db.Open(context.Background(), db.Config{Driver: "sqlite", DSN: ":memory:"})
	t.Cleanup(func() { _ = d.Close() })
	_ = db.Migrate(d, "sqlite")
	s := &Store{DB: d, Now: time.Now}
	id, err := s.Create(context.Background(), &Script{Name: "hello", Content: "echo hi"})
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(context.Background(), id)
	if err != nil || got.Name != "hello" {
		t.Fatalf("get: %v %+v", err, got)
	}
	got.Description = "demo"
	if err := s.Update(context.Background(), got); err != nil {
		t.Fatal(err)
	}
	list, err := s.List(context.Background())
	if err != nil || len(list) != 1 || list[0].Description != "demo" {
		t.Fatalf("list: %v %+v", err, list)
	}
	if err := s.Delete(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(context.Background(), id); err == nil {
		t.Fatal("get after delete should fail")
	}
}
