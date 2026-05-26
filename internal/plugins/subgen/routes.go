package subgen

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// All admin endpoints are mounted at /api/admin/plugins/subgen (the gated mux
// in router.go adds the prefix). Patterns here are relative to that prefix.

// registerRoutes wires every subgen admin REST endpoint. p.deps is already
// populated by RegisterRoutes before this runs.
func (p *Plugin) registerRoutes(mux plugins.Mux) {
	// Subscriptions
	mux.HandleFunc("GET /subscriptions", p.listSubscriptions)
	mux.HandleFunc("POST /subscriptions", p.createSubscription)
	mux.HandleFunc("PATCH /subscriptions/{id}", p.updateSubscription)
	mux.HandleFunc("DELETE /subscriptions/{id}", p.deleteSubscription)
	mux.HandleFunc("POST /subscriptions/{id}/rotate-token", p.rotateToken)
	mux.HandleFunc("GET /subscriptions/{id}/inbounds", p.getInbounds)
	mux.HandleFunc("PUT /subscriptions/{id}/inbounds", p.setInbounds)
	mux.HandleFunc("GET /subscriptions/{id}/preview", p.previewSubscription)

	// Templates
	mux.HandleFunc("GET /templates", p.listTemplates)
	mux.HandleFunc("POST /templates", p.createTemplate)
	mux.HandleFunc("PATCH /templates/{id}", p.updateTemplate)
	mux.HandleFunc("DELETE /templates/{id}", p.deleteTemplate)

	// Catalog
	mux.HandleFunc("GET /categories", p.listCategories)
}

// store builds a fresh Store bound to the runtime deps. Cheap to construct —
// it only wraps the shared *sqlx.DB and clock.
func (p *Plugin) store() *Store {
	return &Store{DB: p.deps.DB, Now: p.deps.Now}
}

// pathID parses the {id} path value as an int64.
func pathID(r *http.Request) (int64, error) {
	return strconv.ParseInt(r.PathValue("id"), 10, 64)
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

// subscriptionView is the trimmed JSON shape the frontend consumes.
type subscriptionView struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Token      string `json:"token"`
	TemplateID int64  `json:"template_id"`
	Enabled    bool   `json:"enabled"`
}

func toSubscriptionView(s Subscription) subscriptionView {
	return subscriptionView{
		ID:         s.ID,
		Name:       s.Name,
		Token:      s.Token,
		TemplateID: s.TemplateID,
		Enabled:    s.Enabled,
	}
}

func (p *Plugin) listSubscriptions(w http.ResponseWriter, r *http.Request) {
	subs, err := p.store().ListSubscriptions(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	out := make([]subscriptionView, 0, len(subs))
	for _, s := range subs {
		out = append(out, toSubscriptionView(s))
	}
	writeJSON(w, 200, out)
}

type createSubscriptionBody struct {
	Name       string `json:"name"`
	TemplateID int64  `json:"template_id"`
}

func (p *Plugin) createSubscription(w http.ResponseWriter, r *http.Request) {
	var b createSubscriptionBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	if strings.TrimSpace(b.Name) == "" {
		writeErr(w, 400, errors.New("name required"))
		return
	}
	sub, err := p.store().CreateSubscription(r.Context(), b.Name, b.TemplateID)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, toSubscriptionView(sub))
}

type updateSubscriptionBody struct {
	Name       string `json:"name"`
	TemplateID int64  `json:"template_id"`
	Enabled    bool   `json:"enabled"`
}

func (p *Plugin) updateSubscription(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var b updateSubscriptionBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	st := p.store()
	if err := st.UpdateSubscription(r.Context(), id, b.Name, b.TemplateID, b.Enabled); err != nil {
		writeErr(w, 500, err)
		return
	}
	sub, err := st.Subscription(r.Context(), id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, toSubscriptionView(sub))
}

func (p *Plugin) deleteSubscription(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := p.store().DeleteSubscription(r.Context(), id); err != nil {
		writeErr(w, 500, err)
		return
	}
	w.WriteHeader(204)
}

func (p *Plugin) rotateToken(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	st := p.store()
	if err := st.RotateToken(r.Context(), id); err != nil {
		writeErr(w, 500, err)
		return
	}
	sub, err := st.Subscription(r.Context(), id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, map[string]any{"token": sub.Token})
}

func (p *Plugin) getInbounds(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	sels, err := p.store().InboundsFor(r.Context(), id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	if sels == nil {
		sels = []Selection{}
	}
	writeJSON(w, 200, sels)
}

type setInboundsBody struct {
	Inbounds []Selection `json:"inbounds"`
}

func (p *Plugin) setInbounds(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var b setInboundsBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	if err := p.store().SetInbounds(r.Context(), id, b.Inbounds); err != nil {
		writeErr(w, 500, err)
		return
	}
	w.WriteHeader(204)
}

func (p *Plugin) previewSubscription(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	target := r.URL.Query().Get("target")
	st := p.store()
	sub, err := st.Subscription(r.Context(), id)
	if err != nil {
		writeErr(w, 404, ErrNotFound)
		return
	}
	svc := &Service{Store: st, Now: p.deps.Now, RulesetBase: DefaultRulesetBase}
	body, ct, err := svc.Generate(r.Context(), sub.Token, target)
	if err != nil {
		switch {
		case errors.Is(err, ErrBadTarget):
			writeErr(w, 400, err)
		case errors.Is(err, ErrNotFound):
			writeErr(w, 404, err)
		default:
			writeErr(w, 500, err)
		}
		return
	}
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(200)
	_, _ = w.Write([]byte(body))
}

// ─── Templates ───────────────────────────────────────────────────────────────

// templateView is the JSON shape returned by /templates endpoints.
type templateView struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Builtin   bool   `json:"builtin"`
	RulesJSON string `json:"rules_json"`
}

func toTemplateView(t Template) templateView {
	return templateView{ID: t.ID, Name: t.Name, Builtin: t.Builtin, RulesJSON: t.RulesJSON}
}

func (p *Plugin) listTemplates(w http.ResponseWriter, r *http.Request) {
	tpls, err := p.store().ListTemplates(r.Context())
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	out := make([]templateView, 0, len(tpls))
	for _, t := range tpls {
		out = append(out, toTemplateView(t))
	}
	writeJSON(w, 200, out)
}

type templateBody struct {
	Name      string `json:"name"`
	RulesJSON string `json:"rules_json"`
}

func (p *Plugin) createTemplate(w http.ResponseWriter, r *http.Request) {
	var b templateBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	if strings.TrimSpace(b.Name) == "" {
		writeErr(w, 400, errors.New("name required"))
		return
	}
	if _, err := ParseTemplate(b.RulesJSON); err != nil {
		writeErr(w, 400, err)
		return
	}
	st := p.store()
	id, err := st.CreateTemplate(r.Context(), b.Name, false, b.RulesJSON)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	tpl, err := st.Template(r.Context(), id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, toTemplateView(tpl))
}

func (p *Plugin) updateTemplate(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	var b templateBody
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeErr(w, 400, err)
		return
	}
	if strings.TrimSpace(b.Name) == "" {
		writeErr(w, 400, errors.New("name required"))
		return
	}
	if _, err := ParseTemplate(b.RulesJSON); err != nil {
		writeErr(w, 400, err)
		return
	}
	st := p.store()
	existing, err := st.Template(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, 404, errors.New("template not found"))
			return
		}
		writeErr(w, 500, err)
		return
	}
	if existing.Builtin {
		writeErr(w, 403, errors.New("built-in template is read-only"))
		return
	}
	if err := st.UpdateTemplate(r.Context(), id, b.Name, b.RulesJSON); err != nil {
		writeErr(w, 500, err)
		return
	}
	tpl, err := st.Template(r.Context(), id)
	if err != nil {
		writeErr(w, 500, err)
		return
	}
	writeJSON(w, 200, toTemplateView(tpl))
}

func (p *Plugin) deleteTemplate(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r)
	if err != nil {
		writeErr(w, 400, err)
		return
	}
	st := p.store()
	existing, err := st.Template(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeErr(w, 404, errors.New("template not found"))
			return
		}
		writeErr(w, 500, err)
		return
	}
	if existing.Builtin {
		writeErr(w, 403, errors.New("built-in template is read-only"))
		return
	}
	if err := st.DeleteTemplate(r.Context(), id); err != nil {
		writeErr(w, 500, err)
		return
	}
	w.WriteHeader(204)
}

// ─── Catalog ─────────────────────────────────────────────────────────────────

// categoryView surfaces a unified category to the UI. RuleURLs holds the
// resolved Surge rule lines (RULE-SET GitHub addresses for remote rulesets,
// or the native directive like "GEOIP,CN,DIRECT").
type categoryView struct {
	Name          string   `json:"name"`
	DefaultPolicy string   `json:"default_policy"`
	RuleURLs      []string `json:"rule_urls"`
}

func (p *Plugin) listCategories(w http.ResponseWriter, _ *http.Request) {
	out := make([]categoryView, 0, len(UnifiedCategories))
	for _, c := range UnifiedCategories {
		urls := ResolveRuleLines(c.Name, c.DefaultPolicy, "surge", DefaultRulesetBase)
		if urls == nil {
			urls = []string{}
		}
		out = append(out, categoryView{
			Name:          c.Name,
			DefaultPolicy: c.DefaultPolicy,
			RuleURLs:      urls,
		})
	}
	writeJSON(w, 200, out)
}
