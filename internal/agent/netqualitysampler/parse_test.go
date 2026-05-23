package netqualitysampler

import (
	"errors"
	"testing"
)

func TestParse_OK(t *testing.T) {
	out := `PING 1.1.1.1 (1.1.1.1) 56(84) bytes of data.
64 bytes from 1.1.1.1: icmp_seq=1 ttl=58 time=1.83 ms
64 bytes from 1.1.1.1: icmp_seq=2 ttl=58 time=2.04 ms
64 bytes from 1.1.1.1: icmp_seq=3 ttl=58 time=1.95 ms

--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss, time 2003ms
rtt min/avg/max/mdev = 1.823/1.941/2.039/0.088 ms`
	s, err := parsePingOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	if s.Status != "ok" {
		t.Errorf("status=%q want ok", s.Status)
	}
	if s.LossPct != 0 {
		t.Errorf("loss=%v want 0", s.LossPct)
	}
	if s.RTTAvgMs == nil || *s.RTTAvgMs != 1.941 {
		t.Errorf("avg=%v want 1.941", s.RTTAvgMs)
	}
	if s.JitterMs == nil || *s.JitterMs != 0.088 {
		t.Errorf("mdev=%v want 0.088", s.JitterMs)
	}
}

func TestParse_TotalLoss(t *testing.T) {
	out := `PING 192.0.2.1 (192.0.2.1) 56(84) bytes of data.

--- 192.0.2.1 ping statistics ---
3 packets transmitted, 0 received, 100% packet loss, time 2046ms`
	s, err := parsePingOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	if s.Status != "lost" {
		t.Errorf("status=%q want lost", s.Status)
	}
	if s.LossPct != 100 {
		t.Errorf("loss=%v want 100", s.LossPct)
	}
	if s.RTTAvgMs != nil {
		t.Errorf("rtt avg should stay nil on total loss, got %v", *s.RTTAvgMs)
	}
}

func TestParse_PartialLoss(t *testing.T) {
	out := `--- 8.8.8.8 ping statistics ---
10 packets transmitted, 7 received, 30% packet loss, time 9023ms
rtt min/avg/max/mdev = 10.123/12.456/15.789/1.234 ms`
	s, err := parsePingOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	if s.Status != "ok" || s.LossPct != 30 {
		t.Errorf("status=%q loss=%v; want ok / 30", s.Status, s.LossPct)
	}
	if s.RTTAvgMs == nil || *s.RTTAvgMs != 12.456 {
		t.Errorf("avg=%v want 12.456", s.RTTAvgMs)
	}
}

func TestParse_BusyboxErrorsField(t *testing.T) {
	// some busybox / older iputils variants insert "+N errors" before "packet loss"
	out := `--- 192.0.2.1 ping statistics ---
4 packets transmitted, 2 received, +2 errors, 50% packet loss, time 3041ms
rtt min/avg/max/mdev = 4.5/6.2/8.1/1.5 ms`
	s, err := parsePingOutput(out)
	if err != nil {
		t.Fatalf("busybox variant should parse: %v", err)
	}
	if s.LossPct != 50 || s.Status != "ok" {
		t.Errorf("loss=%v status=%q want 50/ok", s.LossPct, s.Status)
	}
}

func TestParse_MissingSummary(t *testing.T) {
	// Ping failed to even start a probe — no summary line. The sampler
	// maps this to status="error" so the operator sees something
	// happened, but parse itself just signals "no summary".
	out := `ping: connect: Network is unreachable`
	_, err := parsePingOutput(out)
	if !errors.Is(err, errNoLossLine) {
		t.Errorf("err=%v want errNoLossLine", err)
	}
}

func TestParse_RefusesLocalisedSummary(t *testing.T) {
	// Locked-in design choice: the parser is English-only. If we ever
	// localise it we'd need a per-locale regex set and the build would
	// have to ship a locale matrix — moving target, no upside. The
	// agent forces LC_ALL=C in the child env (sampler.go:runPing) so
	// real probes always get English. This test pins that contract:
	// a localised summary MUST produce errNoLossLine, so a regression
	// that strips the env var would surface as zero data immediately
	// rather than silently after an OS upgrade.
	out := `--- 1.1.1.1 ping 统计 ---
3 包已发送, 3 已接收, 0% 包丢失, 时间 2003ms
往返延时 最小/平均/最大/标准差 = 1.0/2.0/3.0/0.5 毫秒`
	if _, err := parsePingOutput(out); !errors.Is(err, errNoLossLine) {
		t.Errorf("localised output should be rejected; got err=%v", err)
	}
}

func TestParse_BSDStyleHeader(t *testing.T) {
	// macOS / BSD: "round-trip min/avg/max/stddev = X/Y/Z/W ms".
	out := `--- 1.1.1.1 ping statistics ---
3 packets transmitted, 3 received, 0% packet loss
round-trip min/avg/max/stddev = 1.2/1.5/1.9/0.3 ms`
	s, err := parsePingOutput(out)
	if err != nil {
		t.Fatal(err)
	}
	if s.RTTAvgMs == nil || *s.RTTAvgMs != 1.5 {
		t.Errorf("avg=%v want 1.5", s.RTTAvgMs)
	}
}
