package cloudflare

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func (p *Plugin) RegisterRoutes(mux plugins.Mux, deps plugins.Deps) {
	if p.store == nil {
		p.store = &plugins.Store{DB: deps.DB, Now: deps.Now}
	}
	mux.HandleFunc("GET /zones", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		zones, err := c.ListZones(r.Context())
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(zones)
	})
	mux.HandleFunc("GET /zones/{id}/records", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		recs, err := c.ListRecords(r.Context(), r.PathValue("id"))
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(recs)
	})
	mux.HandleFunc("POST /zones/{id}/records", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			httpJSONErr(w, 400, err); return
		}
		out, err := c.CreateRecord(r.Context(), r.PathValue("id"), body)
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("PATCH /zones/{id}/records/{rid}", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		out, err := c.PatchRecord(r.Context(), r.PathValue("id"), r.PathValue("rid"), body)
		if err != nil { httpJSONErr(w, 502, err); return }
		_ = json.NewEncoder(w).Encode(out)
	})
	mux.HandleFunc("DELETE /zones/{id}/records/{rid}", func(w http.ResponseWriter, r *http.Request) {
		c, err := p.client(r)
		if err != nil { httpJSONErr(w, 400, err); return }
		if err := c.DeleteRecord(r.Context(), r.PathValue("id"), r.PathValue("rid")); err != nil {
			httpJSONErr(w, 502, err); return
		}
		w.WriteHeader(204)
	})
}

func (p *Plugin) client(r *http.Request) (*Client, error) {
	row, err := p.store.Get(r.Context(), "cloudflare")
	if err != nil { return nil, err }
	var cfg struct{ APIToken string `json:"api_token"` }
	_ = json.Unmarshal(row.ConfigJSON, &cfg)
	if strings.TrimSpace(cfg.APIToken) == "" {
		return nil, jsonErrText("api_token not configured")
	}
	return &Client{BaseURL: p.baseURL, Token: cfg.APIToken}, nil
}

type jsonErrText string

func (e jsonErrText) Error() string { return string(e) }

func httpJSONErr(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error": err.Error(),
		"code":  "cloudflare_api_error",
	})
}
