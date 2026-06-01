package auth

import (
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestDummyHashIsValidAndRejects(t *testing.T) {
	if _, err := bcrypt.Cost([]byte(DummyHash)); err != nil {
		t.Fatalf("DummyHash is not a valid bcrypt hash: %v", err)
	}
	if VerifyPassword(DummyHash, "anything") {
		t.Fatal("DummyHash must not verify any input password")
	}
}
