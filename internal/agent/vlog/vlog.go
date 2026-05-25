// Package vlog is a process-wide debug-log gate for the agent. When the
// gate is off (the default), Debugf is a cheap no-op so callers can
// sprinkle debug lines on hot paths (file chunks, ws frames) without
// worrying about cost. The gate is flipped at runtime by the server-side
// ConfigUpdate.LogVerbose field — see wsclient.applyConfig.
package vlog

import (
	"log"
	"sync/atomic"
)

var enabled atomic.Bool

// SetEnabled toggles debug-log output. Returns the previous value so
// callers can log a single state-change line themselves.
func SetEnabled(on bool) bool { return enabled.Swap(on) }

// Enabled reports whether Debugf will print.
func Enabled() bool { return enabled.Load() }

// Debugf formats and prints when verbose is on. The "DBG " prefix makes
// these lines greppable in journalctl regardless of the standard log
// flags the agent was started with.
func Debugf(format string, args ...any) {
	if !enabled.Load() {
		return
	}
	log.Printf("DBG "+format, args...)
}
