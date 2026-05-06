package api

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/hg-claw/Shepherd/internal/serversvc"
)

type ServersAPI struct {
	Servers *serversvc.Service
}

func (a *ServersAPI) List(w http.ResponseWriter, r *http.Request) {
	out, err := a.Servers.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, out)
}

type createReq struct {
	Name         string `json:"name"`
	PublicAlias  string `json:"public_alias"`
	PublicGroup  string `json:"public_group"`
	CountryCode  string `json:"country_code"`
	ShowOnPublic bool   `json:"show_on_public"`
}

func (a *ServersAPI) Create(w http.ResponseWriter, r *http.Request) {
	var in createReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	if strings.TrimSpace(in.Name) == "" {
		writeError(w, 400, "name required")
		return
	}
	srv, err := a.Servers.Create(r.Context(), serversvc.CreateInput{
		Name: in.Name, PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 201, srv)
}

func (a *ServersAPI) Get(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	srv, err := a.Servers.Get(r.Context(), id)
	if errors.Is(err, serversvc.ErrNotFound) {
		writeError(w, 404, "not found")
		return
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, srv)
}

type patchReq struct {
	Name         *string `json:"name"`
	PublicAlias  *string `json:"public_alias"`
	PublicGroup  *string `json:"public_group"`
	CountryCode  *string `json:"country_code"`
	ShowOnPublic *bool   `json:"show_on_public"`
}

func (a *ServersAPI) Patch(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	var in patchReq
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	srv, err := a.Servers.Patch(r.Context(), id, serversvc.PatchInput{
		Name: in.Name, PublicAlias: in.PublicAlias, PublicGroup: in.PublicGroup,
		CountryCode: in.CountryCode, ShowOnPublic: in.ShowOnPublic,
	})
	if errors.Is(err, serversvc.ErrNotFound) {
		writeError(w, 404, "not found")
		return
	}
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, srv)
}

func (a *ServersAPI) Delete(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(r, "/api/servers/")
	if !ok {
		writeError(w, 400, "bad id")
		return
	}
	if err := a.Servers.Delete(r.Context(), id); err != nil {
		if errors.Is(err, serversvc.ErrNotFound) {
			writeError(w, 404, "not found")
			return
		}
		writeError(w, 500, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// pathID extracts the trailing numeric segment after `prefix`. Returns (0,false) if
// the request path doesn't match `prefix<digits>` (no trailing slash, no extra segments).
func pathID(r *http.Request, prefix string) (int64, bool) {
	if !strings.HasPrefix(r.URL.Path, prefix) {
		return 0, false
	}
	rest := strings.TrimPrefix(r.URL.Path, prefix)
	if rest == "" || strings.ContainsRune(rest, '/') {
		return 0, false
	}
	id, err := strconv.ParseInt(rest, 10, 64)
	if err != nil {
		return 0, false
	}
	return id, true
}
