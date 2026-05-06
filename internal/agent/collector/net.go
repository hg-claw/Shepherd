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
	rxBps = int64(float64(rx-m.prevRx) / dt)
	txBps = int64(float64(tx-m.prevTx) / dt)
	m.prevRx, m.prevTx, m.prevTS = rx, tx, now
	return rxBps, txBps, true
}
