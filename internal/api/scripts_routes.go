package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/hg-claw/Shepherd/internal/auth"
	"github.com/hg-claw/Shepherd/internal/scriptsvc"
)

type ScriptsAPI struct {
	Store   *scriptsvc.Store
	Service *scriptsvc.Service
}

type scriptDTO struct {
	ID              int64             `json:"id"`
	Name            string            `json:"name"`
	Description     string            `json:"description"`
	Content         string            `json:"content"`
	Params          []scriptsvc.Param `json:"params"`
	DefaultTimeoutS *int              `json:"default_timeout_s,omitempty"`
}

func (a *ScriptsAPI) List(w http.ResponseWriter, r *http.Request) {
	list, err := a.Store.List(r.Context())
	if err != nil {
		writeError(w, 500, err.Error())
		return
	}
	out := make([]scriptDTO, 0, len(list))
	for _, sc := range list {
		var params []scriptsvc.Param
		_ = json.Unmarshal([]byte(sc.ParamsJSON), &params)
		out = append(out, scriptDTO{
			ID: sc.ID, Name: sc.Name, Description: sc.Description,
			Content: sc.Content, Params: params, DefaultTimeoutS: sc.DefaultTimeoutS,
		})
	}
	writeJSON(w, 200, out)
}

func (a *ScriptsAPI) Create(w http.ResponseWriter, r *http.Request) {
	var dto scriptDTO
	if err := decodeJSON(r, &dto); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	pj, _ := json.Marshal(dto.Params)
	id, err := a.Store.Create(r.Context(), &scriptsvc.Script{
		Name: dto.Name, Description: dto.Description, Content: dto.Content,
		ParamsJSON: string(pj), DefaultTimeoutS: dto.DefaultTimeoutS,
	})
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	dto.ID = id
	writeJSON(w, 200, dto)
}

func (a *ScriptsAPI) Update(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var dto scriptDTO
	if err := decodeJSON(r, &dto); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	dto.ID = id
	pj, _ := json.Marshal(dto.Params)
	if err := a.Store.Update(r.Context(), &scriptsvc.Script{
		ID: id, Name: dto.Name, Description: dto.Description, Content: dto.Content,
		ParamsJSON: string(pj), DefaultTimeoutS: dto.DefaultTimeoutS,
	}); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, dto)
}

func (a *ScriptsAPI) Delete(w http.ResponseWriter, r *http.Request) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err := a.Store.Delete(r.Context(), id); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	w.WriteHeader(204)
}

type runReq struct {
	Args            map[string]string `json:"args"`
	TargetServerIDs []int64           `json:"target_server_ids"`
}

type runResp struct {
	RunID int64 `json:"run_id"`
}

func (a *ScriptsAPI) Run(w http.ResponseWriter, r *http.Request) {
	admin, ok := auth.AdminFromContext(r.Context())
	if !ok {
		writeError(w, 401, "unauth")
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var req runReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, 400, "bad json")
		return
	}
	rid, err := a.Service.Run(r.Context(), id, admin.ID, req.Args, req.TargetServerIDs)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	writeJSON(w, 200, runResp{RunID: rid})
}

func (a *ScriptsAPI) RunsList(w http.ResponseWriter, r *http.Request) {
	type row struct {
		ID         int64   `db:"id" json:"id"`
		ScriptID   int64   `db:"script_id" json:"script_id"`
		StartedAt  string  `db:"started_at" json:"started_at"`
		FinishedAt *string `db:"finished_at" json:"finished_at,omitempty"`
	}
	var rows []row
	if err := a.Store.DB.SelectContext(r.Context(), &rows,
		`SELECT id, script_id, started_at, finished_at FROM script_runs ORDER BY started_at DESC LIMIT 200`); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, rows)
}

type targetRow struct {
	ID           int64   `db:"id" json:"id"`
	ServerID     int64   `db:"server_id" json:"server_id"`
	PTYSessionID *int64  `db:"pty_session_id" json:"pty_session_id,omitempty"`
	Status       string  `db:"status" json:"status"`
	ExitCode     *int    `db:"exit_code" json:"exit_code,omitempty"`
	StartedAt    *string `db:"started_at" json:"started_at,omitempty"`
	FinishedAt   *string `db:"finished_at" json:"finished_at,omitempty"`
}

func (a *ScriptsAPI) RunDetail(w http.ResponseWriter, r *http.Request) {
	rid, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var rows []targetRow
	if err := a.Store.DB.SelectContext(r.Context(), &rows,
		`SELECT id, server_id, pty_session_id, status, exit_code, started_at, finished_at
		 FROM script_run_targets WHERE run_id=?`, rid); err != nil {
		writeError(w, 500, err.Error())
		return
	}
	writeJSON(w, 200, rows)
}
