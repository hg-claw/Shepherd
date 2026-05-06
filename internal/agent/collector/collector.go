package collector

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"
	"github.com/hg-claw/Shepherd/internal/agentapi"
)

type Sender interface {
	Send(env agentapi.Envelope) error
}

type Collector struct {
	Sender    Sender
	IntervalS atomic.Int32 // seconds, set via SetInterval; default 30 if zero
	netMeter  NetMeter
}

// SetInterval is called when a config.update arrives.
func (c *Collector) SetInterval(s int) {
	if s < 5 {
		s = 5
	}
	c.IntervalS.Store(int32(s))
}

func (c *Collector) Run(ctx context.Context) {
	if c.IntervalS.Load() == 0 {
		c.IntervalS.Store(30)
	}
	for {
		interval := time.Duration(c.IntervalS.Load()) * time.Second
		t := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
			c.tick(ctx)
		}
	}
}

func (c *Collector) tick(ctx context.Context) {
	t, ok := c.sample()
	if !ok {
		return
	}
	env, err := agentapi.Frame(agentapi.TypeTelemetry, t)
	if err != nil {
		return
	}
	_ = c.Sender.Send(env)
}

func (c *Collector) sample() (agentapi.Telemetry, bool) {
	cpuPcts, err := cpu.Percent(0, false)
	if err != nil || len(cpuPcts) == 0 {
		return agentapi.Telemetry{}, false
	}
	v, err := mem.VirtualMemory()
	if err != nil {
		return agentapi.Telemetry{}, false
	}
	la, _ := load.Avg()
	disks, _ := Disks()
	rx, tx, netOK := c.netMeter.Sample()
	if !netOK {
		return agentapi.Telemetry{}, false
	}
	tcpConn := countEstablished()

	return agentapi.Telemetry{
		TS:       time.Now().UTC(),
		CPUPct:   cpuPcts[0],
		MemUsed:  int64(v.Used),
		MemTotal: int64(v.Total),
		Load1:    la.Load1,
		Load5:    la.Load5,
		Load15:   la.Load15,
		NetRxBps: rx,
		NetTxBps: tx,
		TCPConn:  tcpConn,
		Disks:    disks,
	}, true
}

func countEstablished() int {
	conns, err := gnet.Connections("tcp")
	if err != nil {
		return 0
	}
	n := 0
	for _, c := range conns {
		if c.Status == "ESTABLISHED" {
			n++
		}
	}
	return n
}
