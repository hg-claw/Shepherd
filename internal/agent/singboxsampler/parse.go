// Package singboxsampler provides utilities for parsing and collecting
// sing-box traffic statistics via the clash-compatible API.
package singboxsampler

import (
	"encoding/json"
	"fmt"
)

// TagBytes holds cumulative upload/download bytes for one inbound tag,
// as reported by the currently-active connections at a single poll instant.
type TagBytes struct {
	Up   int64
	Down int64
}

// ConnSnapshot is a map from inbound tag to its aggregated byte counters.
type ConnSnapshot map[string]TagBytes

// connectionsResponse mirrors the top-level JSON object returned by the
// sing-box clash-api GET /connections endpoint.
type connectionsResponse struct {
	Connections []connectionEntry `json:"connections"`
}

type connectionEntry struct {
	Upload   int64          `json:"upload"`
	Download int64          `json:"download"`
	Metadata connectionMeta `json:"metadata"`
}

type connectionMeta struct {
	Inbound string `json:"inbound"`
}

// ParseConnections parses the raw JSON body of a GET /connections response
// and returns per-inbound-tag cumulative bytes aggregated across all active
// connections. Connections with an empty metadata.inbound tag are skipped.
func ParseConnections(data []byte) (ConnSnapshot, error) {
	var resp connectionsResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("singboxsampler: parse connections: %w", err)
	}

	out := make(ConnSnapshot, 8)
	for _, c := range resp.Connections {
		tag := c.Metadata.Inbound
		if tag == "" {
			continue
		}
		tb := out[tag]
		tb.Up += c.Upload
		tb.Down += c.Download
		out[tag] = tb
	}
	return out, nil
}
