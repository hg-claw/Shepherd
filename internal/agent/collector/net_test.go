package collector

import (
	"testing"

	"github.com/shirou/gopsutil/v3/net"
)

func TestIsPhysicalIface(t *testing.T) {
	phys := []string{"eth0", "ens3", "enp0s3", "eno1"}
	virt := []string{"lo", "docker0", "veth1234", "br-abcdef", "wg0", "tun0", "tap0"}
	for _, n := range phys {
		if !isPhysicalIface(n) {
			t.Errorf("%q should be physical", n)
		}
	}
	for _, n := range virt {
		if isPhysicalIface(n) {
			t.Errorf("%q should be excluded", n)
		}
	}
}

func TestSumPhysical(t *testing.T) {
	stats := []net.IOCountersStat{
		{Name: "lo", BytesRecv: 1000, BytesSent: 1000},
		{Name: "eth0", BytesRecv: 100, BytesSent: 200},
		{Name: "docker0", BytesRecv: 50, BytesSent: 60},
		{Name: "veth9", BytesRecv: 7, BytesSent: 8},
		{Name: "ens3", BytesRecv: 300, BytesSent: 400},
	}
	rx, tx := sumPhysical(stats)
	if rx != 400 || tx != 600 {
		t.Fatalf("got rx=%d tx=%d, want 400/600", rx, tx)
	}
}
