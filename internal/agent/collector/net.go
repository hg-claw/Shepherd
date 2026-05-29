package collector

import (
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/net"
)

// isPhysicalIface reports whether name is a real uplink interface (not loopback
// or a virtual/container/VPN device). Cumulative traffic and the live rate both
// use this so container/VPN bytes aren't double-counted (counted on both the
// virtual device and the physical NIC).
func isPhysicalIface(name string) bool {
	if name == "lo" {
		return false
	}
	for _, p := range []string{"docker", "veth", "br-", "wg", "tun", "tap"} {
		if strings.HasPrefix(name, p) {
			return false
		}
	}
	return true
}

// sumPhysical sums recv/sent bytes across physical interfaces only.
func sumPhysical(stats []net.IOCountersStat) (rx, tx uint64) {
	for _, s := range stats {
		if !isPhysicalIface(s.Name) {
			continue
		}
		rx += s.BytesRecv
		tx += s.BytesSent
	}
	return rx, tx
}

type NetMeter struct {
	mu     sync.Mutex
	prevRx uint64
	prevTx uint64
	prevTS time.Time
	primed bool
}

// Sample returns the rx/tx bytes-per-second AND the exact per-interval byte
// delta since the last call, summed across physical interfaces. The first call
// primes counters and returns ok=false. On counter reset/wrap it re-primes and
// returns ok=false (caller drops the tick — no spurious accumulation).
func (m *NetMeter) Sample() (rxBps, txBps, rxBytes, txBytes int64, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	stats, err := net.IOCounters(true)
	if err != nil {
		return 0, 0, 0, 0, false
	}
	rx, tx := sumPhysical(stats)
	now := time.Now()
	if !m.primed {
		m.prevRx, m.prevTx, m.prevTS, m.primed = rx, tx, now, true
		return 0, 0, 0, 0, false
	}
	dt := now.Sub(m.prevTS).Seconds()
	if dt <= 0 {
		return 0, 0, 0, 0, false
	}
	if rx < m.prevRx || tx < m.prevTx {
		m.prevRx, m.prevTx, m.prevTS = rx, tx, now
		return 0, 0, 0, 0, false
	}
	dRx := rx - m.prevRx
	dTx := tx - m.prevTx
	m.prevRx, m.prevTx, m.prevTS = rx, tx, now
	return int64(float64(dRx) / dt), int64(float64(dTx) / dt), int64(dRx), int64(dTx), true
}
