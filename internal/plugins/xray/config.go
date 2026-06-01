package xray

import (
	"encoding/json"
	"fmt"
)

// NormaliseRaw parses arbitrary JSON and re-marshals it pretty so the
// content on disk is deterministic. It only rejects syntactically invalid
// JSON; xray's own validator runs on the host after deploy.
func NormaliseRaw(raw []byte) ([]byte, error) {
	var any any
	if err := json.Unmarshal(raw, &any); err != nil {
		return nil, fmt.Errorf("invalid json: %w", err)
	}
	return json.MarshalIndent(any, "", "  ")
}
