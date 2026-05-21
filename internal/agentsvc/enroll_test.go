package agentsvc

import (
	"context"
	"testing"
	"time"
)

func TestService_LookupEnrollment_Unconsumed(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	sid := mustCreateServer(t, svc, "lookup-unconsumed")
	tok, _, err := svc.IssueEnrollmentToken(ctx, sid)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	serverID, err := svc.LookupEnrollment(ctx, tok)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if serverID != sid {
		t.Fatalf("server_id = %d, want %d", serverID, sid)
	}
}

func TestService_LookupEnrollment_RecentlyConsumed(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	sid := mustCreateServer(t, svc, "lookup-recently-consumed")
	tok, _, err := svc.IssueEnrollmentToken(ctx, sid)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	// Simulate the agent having redeemed the token an hour ago.
	if _, err := svc.DB.Exec(
		`UPDATE enrollment_tokens SET consumed_at=$1 WHERE token=$2`,
		time.Now().Add(-time.Hour), tok); err != nil {
		t.Fatalf("update consumed_at: %v", err)
	}
	if _, err := svc.LookupEnrollment(ctx, tok); err != nil {
		t.Fatalf("expected recently-consumed token to be accepted: %v", err)
	}
}

func TestService_LookupEnrollment_StaleConsumed(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	sid := mustCreateServer(t, svc, "lookup-stale-consumed")
	tok, _, _ := svc.IssueEnrollmentToken(ctx, sid)
	if _, err := svc.DB.Exec(
		`UPDATE enrollment_tokens SET consumed_at=$1 WHERE token=$2`,
		time.Now().Add(-25*time.Hour), tok); err != nil {
		t.Fatalf("update consumed_at: %v", err)
	}
	if _, err := svc.LookupEnrollment(ctx, tok); err != ErrInvalidEnrollment {
		t.Fatalf("expected ErrInvalidEnrollment, got %v", err)
	}
}

func TestService_LookupEnrollment_Unknown(t *testing.T) {
	svc := newSvc(t)
	ctx := context.Background()
	if _, err := svc.LookupEnrollment(ctx, "nope"); err != ErrInvalidEnrollment {
		t.Fatalf("expected ErrInvalidEnrollment, got %v", err)
	}
}
