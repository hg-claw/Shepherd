// Package singboxsampler provides utilities for parsing and collecting
// sing-box traffic statistics via the clash-compatible API.
package singboxsampler

import (
	"encoding/json"
	"fmt"
	"strings"
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

// connectionMeta mirrors the relevant slice of TrackerMetadata.MarshalJSON in
// sing-box (experimental/clashapi/trafficontrol/tracker.go). The inbound info
// lives under metadata.type as "<InboundType>/<Tag>" (e.g. "anytls/landing-…").
// There is no `metadata.inbound` field — looking for one silently swallowed
// every connection and reported zero traffic.
type connectionMeta struct {
	Type string `json:"type"`
}

// inboundTagFromType extracts the user-visible inbound tag from a
// clash-api metadata.type value. Examples:
//
//	"anytls/landing-55ecc720"   → "landing-55ecc720"
//	"vless/relay-aabb1122"      → "relay-aabb1122"
//	"anytls"                    → ""  (no tag on the inbound — skipped)
//
// Skipping the no-tag case keeps untagged inbounds (shouldn't happen for us,
// but defensive) from being aggregated under a "type-only" bucket.
func inboundTagFromType(t string) string {
	if i := strings.IndexByte(t, '/'); i >= 0 {
		return t[i+1:]
	}
	return ""
}

// ParseConnections parses the raw JSON body of a GET /connections response
// and returns per-inbound-tag cumulative bytes aggregated across all active
// connections. Connections without a tagged inbound are skipped.
func ParseConnections(data []byte) (ConnSnapshot, error) {
	var resp connectionsResponse
	if err := json.Unmarshal(data, &resp); err != nil {
		return nil, fmt.Errorf("singboxsampler: parse connections: %w", err)
	}

	out := make(ConnSnapshot, 8)
	for _, c := range resp.Connections {
		tag := inboundTagFromType(c.Metadata.Type)
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
