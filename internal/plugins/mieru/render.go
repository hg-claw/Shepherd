package mieru

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// RenderServerConfig builds the official mita JSON config for one host.
// One process, many users: portBindings are the union of inbound ports
// (BOTH → TCP at port and UDP at port+1), users[] is one entry per inbound.
// MTU is the first non-zero inbound MTU, else 1400 (NoBrand balanced default).
func RenderServerConfig(inbounds []InboundView) ([]byte, error) {
	if len(inbounds) == 0 {
		return nil, errors.New("RenderServerConfig: no inbounds")
	}
	sort.Slice(inbounds, func(i, j int) bool { return inbounds[i].ID < inbounds[j].ID })

	bindings := make([]any, 0, len(inbounds)*2)
	users := make([]any, 0, len(inbounds))
	mtu := 0
	for _, in := range inbounds {
		binds, err := portBindings(in)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binds...)
		users = append(users, map[string]any{
			"name":     in.Username,
			"password": in.Password,
		})
		if mtu == 0 && in.MTU > 0 {
			mtu = in.MTU
		}
	}
	if mtu == 0 {
		mtu = 1400
	}
	cfg := map[string]any{
		"portBindings": bindings,
		"users":        users,
		"loggingLevel": "INFO",
		"mtu":          mtu,
	}
	return json.MarshalIndent(cfg, "", "  ")
}

func portBindings(in InboundView) ([]any, error) {
	switch in.Protocol {
	case "TCP", "UDP":
		return []any{map[string]any{"port": in.Port, "protocol": in.Protocol}}, nil
	case "BOTH":
		if in.Port >= 65535 {
			return nil, fmt.Errorf("inbound %s: BOTH requires port+1 <= 65535", in.Tag)
		}
		return []any{
			map[string]any{"port": in.Port, "protocol": "TCP"},
			map[string]any{"port": in.Port + 1, "protocol": "UDP"},
		}, nil
	default:
		return nil, fmt.Errorf("inbound %s: unsupported protocol %q", in.Tag, in.Protocol)
	}
}
