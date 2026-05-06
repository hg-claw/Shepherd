package collector

import (
	"strings"

	"github.com/shirou/gopsutil/v3/disk"
	"github.com/hg-claw/Shepherd/internal/agentapi"
)

var skipFS = map[string]struct{}{
	"tmpfs": {}, "devtmpfs": {}, "squashfs": {}, "overlay": {}, "proc": {}, "sysfs": {}, "cgroup": {}, "cgroup2": {},
	"autofs": {}, "ramfs": {}, "devpts": {}, "mqueue": {}, "fusectl": {},
}

func Disks() ([]agentapi.Disk, error) {
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil, err
	}
	out := []agentapi.Disk{}
	for _, p := range parts {
		if _, skip := skipFS[strings.ToLower(p.Fstype)]; skip {
			continue
		}
		u, err := disk.Usage(p.Mountpoint)
		if err != nil {
			continue
		}
		out = append(out, agentapi.Disk{Mount: p.Mountpoint, Used: int64(u.Used), Total: int64(u.Total)})
	}
	return out, nil
}
