package sshaudit

import (
	"testing"
	"time"
)

func ptr(n int) *int { return &n }

// portEq compares an *int port against an expected *int.
func portEq(a, b *int) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func TestParseLines_JournalctlShortISO(t *testing.T) {
	loc := time.UTC
	text := `2026-06-16T10:33:01+0000 host sshd[123]: Accepted password for root from 1.2.3.4 port 55012 ssh2
2026-06-16T10:33:02+0000 host sshd[124]: Accepted publickey for ubuntu from 1.2.3.4 port 55013 ssh2: RSA SHA256:abc
2026-06-16T10:33:03+0000 host sshd[125]: Failed password for root from 1.2.3.4 port 55014 ssh2
2026-06-16T10:33:04+0000 host sshd[126]: Failed password for invalid user admin from 1.2.3.4 port 55015 ssh2
2026-06-16T10:33:05+0000 host sshd[127]: Invalid user bob from 5.6.7.8 port 40000
2026-06-16T10:33:06+0000 host sshd[128]: Invalid user carol from 9.9.9.9
2026-06-16T10:33:07+0000 host CRON[200]: pam_unix(cron:session): session opened
2026-06-16T10:33:08+0000 host sshd[129]: Connection closed by 1.2.3.4 port 12345`

	evs := parseLines(text, 2026, loc)
	if len(evs) != 6 {
		t.Fatalf("got %d events, want 6: %+v", len(evs), evs)
	}

	cases := []Event{
		{Result: "accepted", Method: "password", Username: "root", SourceIP: "1.2.3.4", Port: ptr(55012)},
		{Result: "accepted", Method: "publickey", Username: "ubuntu", SourceIP: "1.2.3.4", Port: ptr(55013)},
		{Result: "failed", Method: "password", Username: "root", SourceIP: "1.2.3.4", Port: ptr(55014)},
		{Result: "failed", Method: "password", InvalidUser: true, Username: "admin", SourceIP: "1.2.3.4", Port: ptr(55015)},
		{Result: "failed", Method: "", InvalidUser: true, Username: "bob", SourceIP: "5.6.7.8", Port: ptr(40000)},
		{Result: "failed", Method: "", InvalidUser: true, Username: "carol", SourceIP: "9.9.9.9", Port: nil},
	}
	for i, want := range cases {
		got := evs[i]
		if got.Result != want.Result || got.Method != want.Method ||
			got.InvalidUser != want.InvalidUser || got.Username != want.Username ||
			got.SourceIP != want.SourceIP || !portEq(got.Port, want.Port) {
			t.Errorf("case %d:\n got=%+v\nwant=%+v", i, got, want)
		}
	}
	// First line's timestamp must parse to the exact instant.
	wantTS := time.Date(2026, 6, 16, 10, 33, 1, 0, time.UTC)
	if !evs[0].TS.Equal(wantTS) {
		t.Errorf("ts=%v want %v", evs[0].TS, wantTS)
	}
}

func TestParseLines_SyslogPrefix(t *testing.T) {
	loc := time.UTC
	text := `Jun 16 10:33:01 host sshd[123]: Accepted password for root from 1.2.3.4 port 55012 ssh2
Jun 16 10:33:02 host sshd[124]: Accepted publickey for ubuntu from 1.2.3.4 port 55013 ssh2: ED25519 SHA256:xyz
Jun 16 10:33:03 host sshd[125]: Failed password for root from 1.2.3.4 port 55014 ssh2
Jun 16 10:33:04 host sshd[126]: Failed password for invalid user admin from 1.2.3.4 port 55015 ssh2
Jun 16 10:33:05 host sshd[127]: Invalid user admin from 1.2.3.4 port 55015
Jun 16 10:33:06 host sudo: pam_unix(sudo:session): session opened for user root`

	// Fixed mid-year reference so the rollover heuristic is deterministic
	// regardless of when CI runs.
	ref := time.Date(2026, time.June, 20, 12, 0, 0, 0, loc)
	evs := parseLinesAt(text, ref, loc)
	if len(evs) != 5 {
		t.Fatalf("got %d events, want 5: %+v", len(evs), evs)
	}
	if evs[0].Username != "root" || evs[0].SourceIP != "1.2.3.4" || *evs[0].Port != 55012 {
		t.Errorf("syslog accepted password: %+v", evs[0])
	}
	if !evs[3].InvalidUser || evs[3].Username != "admin" {
		t.Errorf("syslog failed-invalid-user: %+v", evs[3])
	}
	if evs[4].Method != "" || !evs[4].InvalidUser || evs[4].Username != "admin" {
		t.Errorf("syslog bare invalid-user: %+v", evs[4])
	}
	// Year applied from the passed year.
	if evs[0].TS.Year() != 2026 || evs[0].TS.Month() != time.June {
		t.Errorf("syslog ts year/month: %v", evs[0].TS)
	}
}

func TestParseLines_YearRollover(t *testing.T) {
	loc := time.UTC
	// Reading at the start of January 2027: a "Dec 31" syslog line (no year)
	// must be attributed to 2026, while a same-month January line stays 2027.
	ref := time.Date(2027, time.January, 3, 0, 0, 0, 0, loc)

	text := `Dec 31 23:59:59 host sshd[1]: Failed password for root from 1.2.3.4 port 22 ssh2`
	evs := parseLinesAt(text, ref, loc)
	if len(evs) != 1 {
		t.Fatalf("got %d events, want 1", len(evs))
	}
	if evs[0].TS.Year() != 2026 {
		t.Errorf("rollover: year=%d want 2026 (ts=%v)", evs[0].TS.Year(), evs[0].TS)
	}

	// A same-year January line must NOT roll back.
	text2 := `Jan 2 00:00:01 host sshd[1]: Failed password for root from 1.2.3.4 port 22 ssh2`
	evs2 := parseLinesAt(text2, ref, loc)
	if evs2[0].TS.Year() != 2027 {
		t.Errorf("non-rollover: year=%d want 2027", evs2[0].TS.Year())
	}

	// The contract-shaped entry point (text, year, loc) still parses the
	// syslog form: a mid-year line in the current year stays put.
	text3 := `Jun 16 10:33:01 host sshd[1]: Accepted password for root from 1.2.3.4 port 22 ssh2`
	evs3 := parseLines(text3, time.Now().UTC().Year(), loc)
	if len(evs3) != 1 || evs3[0].TS.Month() != time.June {
		t.Errorf("parseLines syslog month: %+v", evs3)
	}
}

func TestParseLines_IgnoresNoise(t *testing.T) {
	loc := time.UTC
	text := `2026-06-16T10:00:00+0000 host sshd[1]: Connection from 1.2.3.4 port 5 on 10.0.0.1 port 22
2026-06-16T10:00:01+0000 host sshd[1]: Disconnected from user root 1.2.3.4 port 5
2026-06-16T10:00:02+0000 host sshd[1]: Received disconnect from 1.2.3.4 port 5:11: disconnected by user
2026-06-16T10:00:03+0000 host systemd[1]: Started Session 3 of user root.
random garbage line with no prefix
2026-06-16T10:00:04+0000 host sshd[1]: pam_unix(sshd:session): session opened for user root`
	evs := parseLines(text, 2026, loc)
	if len(evs) != 0 {
		t.Errorf("expected 0 events from noise, got %d: %+v", len(evs), evs)
	}
}

func TestParseLines_AcceptedNoPortStillParses(t *testing.T) {
	// Defensive: a line missing "port" should still parse with nil port.
	loc := time.UTC
	text := `2026-06-16T10:00:00+0000 host sshd[1]: Accepted password for root from 1.2.3.4 ssh2`
	evs := parseLines(text, 2026, loc)
	if len(evs) != 1 {
		t.Fatalf("got %d want 1", len(evs))
	}
	if evs[0].Port != nil || evs[0].SourceIP != "1.2.3.4" {
		t.Errorf("no-port accepted: %+v", evs[0])
	}
}
