package collector

import (
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/net"
)

type NetMeter struct {
	mu     sync.Mutex
	prevRx uint64
	prevTx uint64
	prevTS time.Time
	primed bool
}

// Sample returns the rx/tx bytes-per-second since the last call, summed across all
// non-loopback interfaces. The first call primes counters and returns (0,0,false).
func (m *NetMeter) Sample() (rxBps, txBps int64, ok bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	stats, err := net.IOCounters(true)
	if err != nil {
		return 0, 0, false
	}
	var rx, tx uint64
	for _, s := range stats {
		if s.Name == "lo" {
			continue
		}
		rx += s.BytesRecv
		tx += s.BytesSent
	}
	now := time.Now()
	if !m.primed {
		m.prevRx, m.prevTx, m.prevTS, m.primed = rx, tx, now, true
		return 0, 0, false
	}
	dt := now.Sub(m.prevTS).Seconds()
	if dt <= 0 {
		return 0, 0, false
	}
	// Guard against counter reset (interface bounce, container restart,
	// or 32-bit counter wraparound). uint64 subtraction wraps around to
	// near-max when rx < prevRx, which we'd then cast to float64/int64 and
	// emit as nonsensical readings like 558921 TB/s.
	// On reset: re-prime from the new baseline and skip this sample.
	if rx < m.prevRx || tx < m.prevTx {
		m.prevRx, m.prevTx, m.prevTS = rx, tx, now
		return 0, 0, false
	}
	rxBps = int64(float64(rx-m.prevRx) / dt)
	txBps = int64(float64(tx-m.prevTx) / dt)
	m.prevRx, m.prevTx, m.prevTS = rx, tx, now
	return rxBps, txBps, true
}
