package subgen

import (
	"encoding/json"
	"net/http"
)

// writeJSON encodes v as JSON with the given status code. Mirrors the helper
// used by the netquality plugin so handlers share one response shape.
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr renders {"error": msg} with the given status code.
func writeErr(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]any{"error": err.Error()})
}
