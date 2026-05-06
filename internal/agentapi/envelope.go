package agentapi

import (
	"encoding/json"
)

// Envelope is the single wire frame for both directions on /agent/ws.
// Sid is reserved for session-correlated frames (Phase 2 PTY/stream); empty in Phase 1.
type Envelope struct {
	Sid  string          `json:"sid,omitempty"`
	Type string          `json:"type"`
	P    json.RawMessage `json:"p"`
}

// Frame builds an Envelope with payload `p` marshaled to JSON.
func Frame(typ string, p any) (Envelope, error) {
	raw, err := json.Marshal(p)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{Type: typ, P: raw}, nil
}

// Decode unmarshals e.P into out.
func (e Envelope) Decode(out any) error {
	return json.Unmarshal(e.P, out)
}
