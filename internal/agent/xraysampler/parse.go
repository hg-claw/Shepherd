// Package xraysampler provides utilities for parsing and collecting
// xray traffic statistics emitted by the xray-core stats API.
package xraysampler

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// StatEntry represents one traffic counter emitted by xray.
type StatEntry struct {
	Kind      string // "inbound" | "outbound"
	Tag       string // inbound/outbound tag name
	Direction string // "uplink" | "downlink"
	Value     int64
}

// ParseStats parses the raw output of `xray api statsquery`.
//
// Two formats are supported:
//   - v1.8.x plain text: one "name: value" counter per line.
//   - v1.9+   JSON:      {"stat":[{"name":"...","value":"..."},...]}
//
// Detection: if the trimmed input starts with '{' it is treated as JSON;
// otherwise it is parsed as plain text.
//
// Counters that do not match inbound/outbound>>>tag>>>traffic>>>{uplink,downlink}
// (e.g., "user>>>..." counters) are silently skipped.
// Tags with the prefix "__shepherd_" are also filtered out.
func ParseStats(data []byte) ([]StatEntry, error) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 {
		return nil, nil
	}

	if trimmed[0] == '{' {
		return parseV19JSON(trimmed)
	}
	return parseV18Text(trimmed)
}

// ---- v1.8 plain-text parser ----

// parseV18Text handles the plain-text one-counter-per-line format:
//
//	inbound>>>tag>>>traffic>>>uplink:    1234567
func parseV18Text(data []byte) ([]StatEntry, error) {
	var out []StatEntry
	sc := bufio.NewScanner(bytes.NewReader(data))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		// Split on ':' — only the last colon separates name from value.
		idx := strings.LastIndex(line, ":")
		if idx < 0 {
			continue // malformed, skip
		}
		name := strings.TrimSpace(line[:idx])
		valStr := strings.TrimSpace(line[idx+1:])

		val, err := strconv.ParseInt(valStr, 10, 64)
		if err != nil {
			continue // malformed value, skip
		}

		e, ok := parseName(name, val)
		if !ok {
			continue
		}
		out = append(out, e)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("xraysampler: scanning plain-text stats: %w", err)
	}
	return out, nil
}

// ---- v1.9 JSON parser ----

type rawStat struct {
	Name  string          `json:"name"`
	Value json.RawMessage `json:"value"`
}

// parseV19JSON handles the v1.9+ JSON object format:
//
//	{"stat":[{"name":"...","value":"123"},...]}
func parseV19JSON(data []byte) ([]StatEntry, error) {
	var obj struct {
		Stat []rawStat `json:"stat"`
	}
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, fmt.Errorf("xraysampler: parsing v1.9 JSON: %w", err)
	}

	var out []StatEntry
	for _, s := range obj.Stat {
		val, err := parseRawValue(s.Value)
		if err != nil {
			continue // skip unparseable values
		}
		e, ok := parseName(s.Name, val)
		if !ok {
			continue
		}
		out = append(out, e)
	}
	return out, nil
}

// parseRawValue converts a JSON value that may be either a number or a
// quoted string (xray v1.9 stringifies int64 counters) into int64.
func parseRawValue(raw json.RawMessage) (int64, error) {
	// Try number first.
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n, nil
	}
	// Try quoted string.
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return 0, fmt.Errorf("cannot parse value %s", raw)
	}
	return strconv.ParseInt(s, 10, 64)
}

// ---- shared name parser ----

// parseName parses a stat name of the form
//
//	kind>>>tag>>>traffic>>>{uplink,downlink}
//
// and returns a StatEntry. Returns ok=false for names that should be skipped.
func parseName(name string, value int64) (StatEntry, bool) {
	parts := strings.Split(name, ">>>")
	if len(parts) != 4 {
		return StatEntry{}, false
	}
	kind := parts[0]
	tag := parts[1]
	// parts[2] should be "traffic" — we don't strictly enforce this
	dir := parts[3]

	// Only inbound and outbound traffic counters.
	if kind != "inbound" && kind != "outbound" {
		return StatEntry{}, false
	}
	// Only uplink / downlink directions.
	if dir != "uplink" && dir != "downlink" {
		return StatEntry{}, false
	}
	// Filter shepherd-internal tags.
	if strings.HasPrefix(tag, "__shepherd_") {
		return StatEntry{}, false
	}

	return StatEntry{
		Kind:      kind,
		Tag:       tag,
		Direction: dir,
		Value:     value,
	}, true
}
