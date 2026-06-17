package sshaudit

import (
	"strconv"
	"strings"
	"time"
)

// Event is one parsed sshd auth line. It is the in-memory form persisted
// into sshaudit_events. Pure parser output — no DB types here so the
// parser stays trivially unit-testable.
type Event struct {
	TS          time.Time
	Result      string // "accepted" | "failed"
	Method      string // "password" | "publickey" | ""
	InvalidUser bool
	Username    string
	SourceIP    string
	Port        *int // nil when the line carried no port
}

// parseLines is a pure parser over journalctl short-iso AND syslog auth
// lines. It returns one Event per recognized sshd auth message; all other
// lines are ignored.
//
//   - journalctl short-iso prefix:
//     "2026-06-16T10:33:01+0000 host sshd[123]: <msg>"
//   - syslog prefix (auth.log/secure), no year:
//     "Jun 16 10:33:01 host sshd[123]: <msg>"
//
// year/loc fill the missing year on syslog lines. The Dec→Jan rollover is
// resolved against a reference instant: a syslog line that reconstructs
// more than ~31 days into the future relative to the reference (e.g. a
// "Dec" line read in the following January) is rolled back one year. The
// reference is the current wall-clock time pinned to `year` — i.e. the
// moment of reading, which is when collectHost passes the current year.
func parseLines(text string, year int, loc *time.Location) []Event {
	if loc == nil {
		loc = time.UTC
	}
	// Reference instant: "now" within the reading year. Using the actual
	// current time (rather than a fixed year boundary) means an early-
	// January read correctly attributes "Dec" lines to year-1 while a
	// mid-year read keeps everything in `year`.
	now := time.Now().In(loc)
	ref := time.Date(year, now.Month(), now.Day(), now.Hour(), now.Minute(), now.Second(), 0, loc)
	return parseLinesAt(text, ref, loc)
}

// parseLinesAt is the reference-time form used by parseLines and the unit
// tests. ref pins the Dec→Jan rollover decision deterministically.
func parseLinesAt(text string, ref time.Time, loc *time.Location) []Event {
	if loc == nil {
		loc = time.UTC
	}
	var out []Event
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, "\r")
		if line == "" {
			continue
		}
		ts, rest, ok := splitPrefix(line, ref, loc)
		if !ok {
			continue
		}
		// rest is everything after "sshd[pid]: ". Only sshd lines reach
		// here (splitPrefix verifies the program token is sshd).
		ev, ok := parseMessage(rest)
		if !ok {
			continue
		}
		ev.TS = ts
		out = append(out, ev)
	}
	return out
}

// splitPrefix peels the timestamp + "host sshd[pid]:" framing off a log
// line, returning the parsed timestamp and the bare message. ok=false for
// non-sshd lines or unparseable prefixes.
func splitPrefix(line string, ref time.Time, loc *time.Location) (time.Time, string, bool) {
	// Find the "sshd[" program marker; the message starts after the
	// following "]: ". This is robust to either prefix style and to the
	// hostname token being present or absent.
	idx := strings.Index(line, "sshd[")
	var procEnd int
	if idx >= 0 {
		// "sshd[123]: msg"
		bracket := strings.Index(line[idx:], "]:")
		if bracket < 0 {
			return time.Time{}, "", false
		}
		procEnd = idx + bracket + len("]:")
	} else {
		// Some daemons log "... sshd: msg" with no pid bracket.
		idx = strings.Index(line, "sshd:")
		if idx < 0 {
			return time.Time{}, "", false
		}
		procEnd = idx + len("sshd:")
	}
	prefix := strings.TrimSpace(line[:idx])
	msg := strings.TrimSpace(line[procEnd:])
	ts, ok := parseTimestamp(prefix, ref, loc)
	if !ok {
		return time.Time{}, "", false
	}
	return ts, msg, true
}

// parseTimestamp pulls the timestamp out of the portion of the line that
// precedes "sshd[". It supports the journalctl short-iso form (leading
// token is a full RFC3339-ish stamp) and the syslog form ("Jun 16
// 10:33:01"), in which case ref/loc supply the missing year.
func parseTimestamp(prefix string, ref time.Time, loc *time.Location) (time.Time, bool) {
	fields := strings.Fields(prefix)
	if len(fields) == 0 {
		return time.Time{}, false
	}
	// journalctl short-iso: first field is the whole stamp, e.g.
	// "2026-06-16T10:33:01+0000". Try a couple of layouts.
	if t, ok := parseISO(fields[0]); ok {
		return t, true
	}
	// syslog: "Jun 16 10:33:01" → three leading fields, no year.
	if len(fields) >= 3 {
		stamp := fields[0] + " " + fields[1] + " " + fields[2]
		if t, err := time.ParseInLocation("Jan 2 15:04:05", stamp, loc); err == nil {
			return rollYear(t, ref, loc), true
		}
	}
	return time.Time{}, false
}

// rollYear assigns a year to a syslog timestamp (which carries none). It
// starts from ref's year, then handles the Dec→Jan wrap: if the line dated
// in ref's year lands more than 31 days in the future relative to ref (a
// "Dec" line read in the following January), it belongs to ref.Year()-1.
//
// The 31-day slack tolerates clock skew between the log host and the reader
// so a fresh line slightly ahead of ref isn't wrongly rolled back a year.
func rollYear(t time.Time, ref time.Time, loc *time.Location) time.Time {
	t = time.Date(ref.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, loc)
	if t.After(ref.AddDate(0, 0, 31)) {
		t = t.AddDate(-1, 0, 0)
	}
	return t
}

// parseISO tries the journalctl short-iso layouts. short-iso emits e.g.
// "2026-06-16T10:33:01+0000" (no colon in the zone). We also accept the
// colon'd RFC3339 form just in case.
func parseISO(s string) (time.Time, bool) {
	for _, layout := range []string{
		"2006-01-02T15:04:05-0700",
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02T15:04:05.999999-0700",
	} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// parseMessage recognizes the five sshd auth message shapes and returns a
// partially-filled Event (TS is set by the caller). ok=false for any line
// we don't care about.
//
// Recognized:
//
//	Accepted password for root from 1.2.3.4 port 55012 ssh2
//	Accepted publickey for ubuntu from 1.2.3.4 port 55013 ssh2: RSA SHA256:...
//	Failed password for root from 1.2.3.4 port 55014 ssh2
//	Failed password for invalid user admin from 1.2.3.4 port 55015 ssh2
//	Invalid user admin from 1.2.3.4 port 55015   (port optional)
func parseMessage(msg string) (Event, bool) {
	switch {
	case strings.HasPrefix(msg, "Accepted "):
		return parseAuthResult(msg[len("Accepted "):], "accepted")
	case strings.HasPrefix(msg, "Failed "):
		return parseAuthResult(msg[len("Failed "):], "failed")
	case strings.HasPrefix(msg, "Invalid user "):
		return parseInvalidUser(msg[len("Invalid user "):])
	}
	return Event{}, false
}

// parseAuthResult parses the body after the leading "Accepted "/"Failed "
// keyword, i.e. "<method> for [invalid user ]<user> from <ip> port <p> ...".
func parseAuthResult(body, result string) (Event, bool) {
	f := strings.Fields(body)
	if len(f) < 4 {
		return Event{}, false
	}
	ev := Event{Result: result}
	ev.Method = f[0] // "password" | "publickey" | "keyboard-interactive/..."
	rest := f[1:]
	if len(rest) == 0 || rest[0] != "for" {
		return Event{}, false
	}
	rest = rest[1:]
	// Optional "invalid user " between "for" and the username.
	if len(rest) >= 2 && rest[0] == "invalid" && rest[1] == "user" {
		ev.InvalidUser = true
		rest = rest[2:]
	}
	if len(rest) == 0 {
		return Event{}, false
	}
	ev.Username = rest[0]
	rest = rest[1:]
	fillFromPort(&ev, rest)
	if ev.SourceIP == "" {
		return Event{}, false
	}
	return ev, true
}

// parseInvalidUser parses the body after "Invalid user ", i.e.
// "<user> from <ip>[ port <p>]". method stays empty; result=failed.
func parseInvalidUser(body string) (Event, bool) {
	f := strings.Fields(body)
	if len(f) < 3 { // need at least "user from ip"
		return Event{}, false
	}
	ev := Event{Result: "failed", InvalidUser: true, Username: f[0]}
	fillFromPort(&ev, f[1:])
	if ev.SourceIP == "" {
		return Event{}, false
	}
	return ev, true
}

// fillFromPort scans the trailing tokens for "from <ip>" and "port <n>",
// populating ev.SourceIP and ev.Port. Tolerant of extra trailing tokens
// (e.g. "ssh2", a key fingerprint).
func fillFromPort(ev *Event, toks []string) {
	for i := 0; i < len(toks); i++ {
		switch toks[i] {
		case "from":
			if i+1 < len(toks) {
				ev.SourceIP = toks[i+1]
				i++
			}
		case "port":
			if i+1 < len(toks) {
				if p, err := strconv.Atoi(toks[i+1]); err == nil {
					ev.Port = &p
				}
				i++
			}
		}
	}
}
