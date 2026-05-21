package api

import (
	"net/http"
	"strconv"

	"github.com/jmoiron/sqlx"
)

type RecordingsAPI struct {
	DB *sqlx.DB
}

func (a *RecordingsAPI) Cast(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var path *string
	if err := a.DB.GetContext(r.Context(), &path, `SELECT recording_path FROM pty_sessions WHERE id=$1`, id); err != nil {
		writeError(w, 404, "not found")
		return
	}
	if path == nil {
		writeError(w, 404, "no recording")
		return
	}
	w.Header().Set("Content-Type", "application/x-asciicast")
	http.ServeFile(w, r, *path)
}
