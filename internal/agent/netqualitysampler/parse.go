// Package netqualitysampler runs periodic ping(1) probes against a
// server-pushed target list and emits NetqualityBatch envelopes back to
// the server. It's the agent-side half of the netquality plugin; the
// catalog + ingest + rollup live server-side under
// internal/plugins/netquality and internal/telemetrysvc.
//
// Why shell out to ping rather than send raw ICMP from Go: raw sockets
// need CAP_NET_RAW on Linux and lift the agent's overall privilege
// requirement, which we explicitly try to keep low (memory:
// project_shepherd zero-cred-persistence invariant). ping(1) is set-uid
// or has the cap bit already; we just parse stdout.
package netqualitysampler

import (
	"errors"
	"regexp"
	"strconv"
)

// stats captures everything we extract from one ping invocation. Pointers
// are nil when the value isn't available (ping returned no replies, etc.)
// so the wire payload can distinguish "we measured 0" from "we couldn't
// measure" — important for billing dashboards downstream.
type stats struct {
	RTTAvgMs *float64
	RTTMinMs *float64
	RTTMaxMs *float64
	JitterMs *float64 // ping's "mdev" — mean deviation across replies
	LossPct  float64  // 0..100; required field
	Status   string   // "ok" | "lost" | "error"
}

var (
	// matches "X packets transmitted, Y received, Z% packet loss" (linux)
	// and "X packets transmitted, Y received, +0 errors, Z% packet loss"
	// (some busybox builds). The optional "+N errors" group is tolerated.
	reLossLinux = regexp.MustCompile(
		`(\d+)\s+packets transmitted,\s+(\d+)\s+received(?:,\s*\+\d+\s+errors)?,\s+([\d.]+)%\s+packet loss`,
	)
	// matches "rtt min/avg/max/mdev = X/Y/Z/W ms"
	// also handles the BSD/macOS variant "round-trip min/avg/max/stddev"
	reRTT = regexp.MustCompile(
		`(?:rtt|round-trip)\s+min/avg/max/(?:mdev|stddev)\s*=\s*([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+)`,
	)
)

// errNoLossLine signals that the output didn't contain a "packet loss"
// summary at all — ping bailed before the summary could be printed.
var errNoLossLine = errors.New("netqualitysampler: no packet-loss summary in ping output")

// parsePingOutput extracts the relevant numbers from one ping(1) stdout
// blob. Returns errNoLossLine if the summary section is missing — the
// caller maps that to status="error".
func parsePingOutput(out string) (stats, error) {
	var s stats
	if m := reLossLinux.FindStringSubmatch(out); m != nil {
		loss, err := strconv.ParseFloat(m[3], 64)
		if err != nil {
			return s, err
		}
		s.LossPct = loss
		if loss >= 100 {
			s.Status = "lost"
		} else {
			s.Status = "ok"
		}
	} else {
		return s, errNoLossLine
	}
	if m := reRTT.FindStringSubmatch(out); m != nil {
		mn, _ := strconv.ParseFloat(m[1], 64)
		av, _ := strconv.ParseFloat(m[2], 64)
		mx, _ := strconv.ParseFloat(m[3], 64)
		mdev, _ := strconv.ParseFloat(m[4], 64)
		s.RTTMinMs = &mn
		s.RTTAvgMs = &av
		s.RTTMaxMs = &mx
		s.JitterMs = &mdev
	}
	// 100% loss → no rtt line is expected; that's fine. Status stays "lost".
	return s, nil
}
