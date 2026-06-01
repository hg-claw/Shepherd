package api

import (
	"encoding/json"
	"net/http"

	"github.com/hg-claw/Shepherd/internal/httpjson"
)

func writeJSON(w http.ResponseWriter, status int, body any) {
	httpjson.Write(w, status, body)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	httpjson.Error(w, status, msg)
}

func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}
