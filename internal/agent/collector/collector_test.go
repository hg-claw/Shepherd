package collector

import "testing"

func TestNetMeter_FirstCallNotPrimed(t *testing.T) {
	var m NetMeter
	_, _, ok := m.Sample()
	if ok {
		t.Error("first call should return ok=false")
	}
}

func TestSetIntervalFloor(t *testing.T) {
	var c Collector
	c.SetInterval(2)
	if c.IntervalS.Load() != 5 {
		t.Errorf("got %d", c.IntervalS.Load())
	}
}
