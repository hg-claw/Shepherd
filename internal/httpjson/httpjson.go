package httpjson

import (
	"encoding/json"
	"net/http"
)

// Write encodes body as JSON with the given status. A nil body writes no
// payload (preserving the api package's 204-style behaviour). Single response
// writer shared by the api package and every plugin.
func Write(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if body != nil {
		_ = json.NewEncoder(w).Encode(body)
	}
}

// Error writes a {"error": msg} envelope with the given status.
func Error(w http.ResponseWriter, code int, msg string) {
	Write(w, code, map[string]string{"error": msg})
}
