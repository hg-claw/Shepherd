package api

import (
	"net/http"

	"github.com/hg-claw/Shepherd/internal/serversvc"
)

type SettingsAPI struct {
	Settings *serversvc.SettingsStore
}

func (a *SettingsAPI) GetAll(w http.ResponseWriter, r *http.Request) {
	m, err := a.Settings.GetAll(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, m)
}

func (a *SettingsAPI) Patch(w http.ResponseWriter, r *http.Request) {
	var in map[string]string
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	for k, v := range in {
		if err := a.Settings.Set(r.Context(), k, v); err != nil {
			writeError(w, 500, err.Error())
			return
		}
	}
	a.GetAll(w, r)
}
