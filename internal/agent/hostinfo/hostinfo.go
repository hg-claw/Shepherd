// Package hostinfo collects a server's static hardware inventory. All external
// commands are best-effort with a short timeout; a failure in one field never
// aborts the others.
package hostinfo

import (
	"context"
	"encoding/json"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/agentapi"
	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/mem"
)

const cmdTimeout = 5 * time.Second

// Collect gathers the host inventory, best-effort. Missing tools/fields yield
// zero values rather than errors.
func Collect(ctx context.Context) agentapi.HostInventory {
	var inv agentapi.HostInventory
	if n, err := cpu.Counts(false); err == nil {
		inv.CPUPhysical = n
	}
	if n, err := cpu.Counts(true); err == nil {
		inv.CPULogical = n
	}
	if ci, err := cpu.Info(); err == nil && len(ci) > 0 {
		inv.CPUModel = strings.TrimSpace(ci[0].ModelName)
	}
	if vm, err := mem.VirtualMemory(); err == nil {
		inv.MemTotal = int64(vm.Total)
	}
	if out, err := run(ctx, "lsblk", "-b", "-d", "-o", "NAME,TYPE,SIZE", "--json"); err == nil {
		if total, perr := parseLsblk(out); perr == nil {
			inv.DiskTotal = total
		}
	}
	inv.GPUs = collectGPUs(ctx)
	return inv
}

func collectGPUs(ctx context.Context) []agentapi.GPU {
	if out, err := run(ctx, "nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"); err == nil {
		if g := parseNvidiaSMI(string(out)); len(g) > 0 {
			return g
		}
	}
	if out, err := run(ctx, "lspci"); err == nil {
		return parseLspciGPUs(string(out))
	}
	return nil
}

func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, cmdTimeout)
	defer cancel()
	return exec.CommandContext(cctx, name, args...).Output()
}

func parseLsblk(data []byte) (int64, error) {
	var out struct {
		BlockDevices []struct {
			Type string          `json:"type"`
			Size json.RawMessage `json:"size"`
		} `json:"blockdevices"`
	}
	if err := json.Unmarshal(data, &out); err != nil {
		return 0, err
	}
	var total int64
	for _, d := range out.BlockDevices {
		if d.Type != "disk" {
			continue
		}
		total += rawToInt64(d.Size)
	}
	return total, nil
}

// rawToInt64 accepts either a JSON number (512) or a quoted string ("512").
func rawToInt64(raw json.RawMessage) int64 {
	s := strings.Trim(strings.TrimSpace(string(raw)), `"`)
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

func parseNvidiaSMI(s string) []agentapi.GPU {
	var gpus []agentapi.GPU
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ",", 2)
		g := agentapi.GPU{Name: strings.TrimSpace(parts[0])}
		if len(parts) == 2 {
			g.VRAMMiB, _ = strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		}
		if g.Name != "" {
			gpus = append(gpus, g)
		}
	}
	return gpus
}

// parseLspciGPUs extracts discrete-GPU controller descriptions from `lspci`
// output: lines that are a "VGA compatible controller" or "3D controller" whose
// vendor is NVIDIA or AMD/ATI (Intel integrated graphics are excluded).
func parseLspciGPUs(s string) []agentapi.GPU {
	var gpus []agentapi.GPU
	for _, line := range strings.Split(s, "\n") {
		if !strings.Contains(line, "VGA compatible controller") && !strings.Contains(line, "3D controller") {
			continue
		}
		i := strings.Index(line, ": ")
		if i < 0 {
			continue
		}
		desc := strings.TrimSpace(line[i+2:])
		low := strings.ToLower(desc)
		isNvidia := strings.Contains(low, "nvidia")
		isAMD := strings.Contains(low, "amd") || strings.Contains(low, "advanced micro devices") || strings.Contains(low, "[amd/ati]") || strings.Contains(low, "radeon")
		if isNvidia || isAMD {
			gpus = append(gpus, agentapi.GPU{Name: desc})
		}
	}
	return gpus
}
