package hostinfo

import (
	"context"
	"testing"
)

func testContext() context.Context { return context.Background() }

func TestParseLsblk(t *testing.T) {
	num := []byte(`{"blockdevices":[{"name":"sda","type":"disk","size":512110190592},{"name":"sr0","type":"rom","size":1073741824},{"name":"loop0","type":"loop","size":100}]}`)
	if got, err := parseLsblk(num); err != nil || got != 512110190592 {
		t.Fatalf("num: got %d err %v", got, err)
	}
	str := []byte(`{"blockdevices":[{"name":"nvme0n1","type":"disk","size":"512110190592"},{"name":"nvme1n1","type":"disk","size":"1000000000000"}]}`)
	if got, err := parseLsblk(str); err != nil || got != 1512110190592 {
		t.Fatalf("str: got %d err %v", got, err)
	}
	if _, err := parseLsblk([]byte(`not json`)); err == nil {
		t.Fatal("expected error on bad json")
	}
}

func TestParseNvidiaSMI(t *testing.T) {
	out := "NVIDIA GeForce RTX 4090, 24564\nNVIDIA GeForce RTX 4090, 24564\n\n"
	g := parseNvidiaSMI(out)
	if len(g) != 2 || g[0].Name != "NVIDIA GeForce RTX 4090" || g[0].VRAMMiB != 24564 {
		t.Fatalf("got %+v", g)
	}
	if parseNvidiaSMI("") != nil {
		t.Fatal("empty → nil")
	}
}

func TestParseLspciGPUs(t *testing.T) {
	out := `00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630 (rev 02)
01:00.0 VGA compatible controller: NVIDIA Corporation AD102 [GeForce RTX 4090] (rev a1)
02:00.0 3D controller: NVIDIA Corporation GA100 [A100]
03:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Navi 31
04:00.0 Ethernet controller: Intel Corporation I210`
	g := parseLspciGPUs(out)
	if len(g) != 3 {
		t.Fatalf("got %d: %+v", len(g), g)
	}
	for _, x := range g {
		if x.VRAMMiB != 0 {
			t.Errorf("lspci vram should be 0: %+v", x)
		}
	}
	if g[0].Name == "" || g[1].Name == "" {
		t.Fatalf("names empty: %+v", g)
	}
}

func TestCollect_PopulatesCPUMem(t *testing.T) {
	inv := Collect(testContext())
	if inv.CPULogical <= 0 {
		t.Fatalf("expected logical CPUs > 0, got %d", inv.CPULogical)
	}
	if inv.MemTotal <= 0 {
		t.Fatalf("expected mem total > 0, got %d", inv.MemTotal)
	}
}
