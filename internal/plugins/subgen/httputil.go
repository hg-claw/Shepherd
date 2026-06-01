package subgen

import (
	"net/http"

	"github.com/hg-claw/Shepherd/internal/httpjson"
)

// writeJSON encodes v as JSON with the given status code.
func writeJSON(w http.ResponseWriter, code int, v any) {
	httpjson.Write(w, code, v)
}

// writeErr renders {"error": msg} with the given status code.
func writeErr(w http.ResponseWriter, code int, err error) {
	httpjson.Error(w, code, err.Error())
}
