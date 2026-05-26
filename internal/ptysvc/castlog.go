package ptysvc

import (
	"bufio"
	"encoding/json"
	"os"
	"strings"
)

// ExtractLog reads an asciicast v2 recording and returns the concatenated
// terminal output ("o" events) as plain text — i.e. exactly what scrolled
// across the screen, minus the timing metadata. Used to surface a readable
// execution log for script runs without making the operator replay an
// asciinema cast. The bool is true when the underlying recording hit its
// size cap and was truncated (best-effort: detected by a trailing marker
// is not written, so we report false here and rely on the writer's flag
// elsewhere; callers that need the truncation state read it from the
// CastWriter at capture time).
func ExtractLog(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()

	var b strings.Builder
	sc := bufio.NewScanner(f)
	// asciicast output events can be large; allow up to 1 MiB per line.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	first := true
	for sc.Scan() {
		line := sc.Bytes()
		if first {
			// First line is the JSON header object, not an event.
			first = false
			continue
		}
		if len(line) == 0 || line[0] != '[' {
			continue
		}
		// Each event is [time, "o"|"i"|..., "data"]. We only want output.
		var ev []json.RawMessage
		if err := json.Unmarshal(line, &ev); err != nil || len(ev) != 3 {
			continue
		}
		var kind string
		if err := json.Unmarshal(ev[1], &kind); err != nil || kind != "o" {
			continue
		}
		var data string
		if err := json.Unmarshal(ev[2], &data); err != nil {
			continue
		}
		b.WriteString(data)
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return b.String(), nil
}
