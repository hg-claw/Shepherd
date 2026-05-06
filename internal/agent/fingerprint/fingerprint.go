package fingerprint

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"os"
	"strings"
)

// Compute returns a stable fingerprint for this host: sha256(machine-id + first-mac).
// Falls back to hostname-based hash if /etc/machine-id is unavailable.
func Compute() (string, error) {
	var seed string
	if b, err := os.ReadFile("/etc/machine-id"); err == nil {
		seed = strings.TrimSpace(string(b))
	} else if hn, err := os.Hostname(); err == nil {
		seed = "hostname:" + hn
	}
	mac := primaryMAC()
	h := sha256.Sum256([]byte(seed + "|" + mac))
	return hex.EncodeToString(h[:]), nil
}

func primaryMAC() string {
	ifs, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, i := range ifs {
		if i.Flags&net.FlagLoopback != 0 || i.HardwareAddr == nil || len(i.HardwareAddr) == 0 {
			continue
		}
		if i.Flags&net.FlagUp == 0 {
			continue
		}
		return i.HardwareAddr.String()
	}
	return ""
}
