package agentapi

import (
	"encoding/binary"
	"errors"
)

const (
	KindPTYOut byte = 0x01
	KindPTYIn  byte = 0x02
	// 0x03 .. 0x0f reserved for future PTY-related kinds.
	KindFileChunk byte = 0x10
)

const maxSidLen = 64

var (
	ErrShortFrame = errors.New("binary frame too short")
	ErrSidTooLong = errors.New("sid exceeds 64 bytes")
)

// EncodeBinary builds [2B sid_len BE][1B kind][sid bytes][payload].
func EncodeBinary(sid string, kind byte, payload []byte) ([]byte, error) {
	if len(sid) > maxSidLen {
		return nil, ErrSidTooLong
	}
	out := make([]byte, 3+len(sid)+len(payload))
	binary.BigEndian.PutUint16(out[0:2], uint16(len(sid)))
	out[2] = kind
	copy(out[3:], sid)
	copy(out[3+len(sid):], payload)
	return out, nil
}

// DecodeBinary parses [2B sid_len BE][1B kind][sid bytes][payload] and returns
// (sid, kind, payload, err). The returned payload slice aliases buf — it is
// only safe to use while buf is alive. Callers that need to retain payload
// across the read loop's next iteration must copy it themselves. Our caller
// (gorilla/websocket ReadMessage) returns a fresh allocation per frame so
// aliasing is safe in our usage.
func DecodeBinary(buf []byte) (string, byte, []byte, error) {
	if len(buf) < 3 {
		return "", 0, nil, ErrShortFrame
	}
	sl := int(binary.BigEndian.Uint16(buf[0:2]))
	if sl > maxSidLen {
		return "", 0, nil, ErrSidTooLong
	}
	if len(buf) < 3+sl {
		return "", 0, nil, ErrShortFrame
	}
	kind := buf[2]
	sid := string(buf[3 : 3+sl])
	payload := buf[3+sl:]
	return sid, kind, payload, nil
}
