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

// FrameSid is like Frame but additionally sets Envelope.Sid for routing.
// The server-side sessionmux.Registry dispatches incoming agent replies
// by Envelope.Sid; the payload also carries sid for in-process consumers,
// but routing happens BEFORE the payload is decoded so the envelope must
// carry it too.
func FrameSid(typ, sid string, p any) (Envelope, error) {
	env, err := Frame(typ, p)
	if err != nil {
		return env, err
	}
	env.Sid = sid
	return env, nil
}

// Decode unmarshals e.P into out.
func (e Envelope) Decode(out any) error {
	return json.Unmarshal(e.P, out)
}
