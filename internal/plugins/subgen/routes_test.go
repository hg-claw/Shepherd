package subgen

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func testPlugin(t *testing.T) (*Plugin, *Store) {
	s := newStore(t)
	return &Plugin{deps: plugins.Deps{DB: s.DB, Now: time.Now}}, s
}

// do builds a mux, registers routes, and dispatches one request through it so
// the {id} path values are populated exactly like the runtime mux does.
func (p *Plugin) do(method, target string, body any) *httptest.ResponseRecorder {
	mux := http.NewServeMux()
	p.registerRoutes(mux)
	var r *http.Request
	if body != nil {
		buf, _ := json.Marshal(body)
		r = httptest.NewRequest(method, target, bytes.NewReader(buf))
	} else {
		r = httptest.NewRequest(method, target, nil)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	return w
}

func TestRoutes_TemplateValidation(t *testing.T) {
	p, _ := testPlugin(t)

	// invalid: unknown category → 400
	w := p.do("POST", "/templates", map[string]any{
		"name":       "bad",
		"rules_json": `{"categories":[{"name":"Nonexistent","policy":"PROXY"}]}`,
	})
	if w.Code != 400 {
		t.Fatalf("invalid rules_json: want 400 got %d body=%s", w.Code, w.Body.String())
	}

	// valid → 200
	w = p.do("POST", "/templates", map[string]any{
		"name":       "good",
		"rules_json": `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`,
	})
	if w.Code != 200 {
		t.Fatalf("valid rules_json: want 200 got %d body=%s", w.Code, w.Body.String())
	}
	var tpl struct {
		ID        int64  `json:"id"`
		Name      string `json:"name"`
		Builtin   bool   `json:"builtin"`
		RulesJSON string `json:"rules_json"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &tpl); err != nil {
		t.Fatal(err)
	}
	if tpl.ID == 0 || tpl.Name != "good" || tpl.Builtin {
		t.Fatalf("created template = %+v", tpl)
	}
}

func TestRoutes_BuiltinTemplateReadOnly(t *testing.T) {
	p, s := testPlugin(t)
	if err := seedBuiltinTemplates(context.Background(), s.DB); err != nil {
		t.Fatal(err)
	}
	tpls, err := s.ListTemplates(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var builtinID int64
	for _, tp := range tpls {
		if tp.Builtin {
			builtinID = tp.ID
			break
		}
	}
	if builtinID == 0 {
		t.Fatal("no builtin template seeded")
	}

	w := p.do("PATCH", "/templates/"+strconv.FormatInt(builtinID, 10), map[string]any{
		"name":       "hijack",
		"rules_json": `{"final":"PROXY"}`,
	})
	if w.Code != 403 {
		t.Fatalf("builtin PATCH: want 403 got %d body=%s", w.Code, w.Body.String())
	}

	w = p.do("DELETE", "/templates/"+strconv.FormatInt(builtinID, 10), nil)
	if w.Code != 403 {
		t.Fatalf("builtin DELETE: want 403 got %d body=%s", w.Code, w.Body.String())
	}
}

func TestRoutes_Categories(t *testing.T) {
	p, _ := testPlugin(t)
	w := p.do("GET", "/categories", nil)
	if w.Code != 200 {
		t.Fatalf("categories: want 200 got %d", w.Code)
	}
	var cats []struct {
		Name          string   `json:"name"`
		DefaultPolicy string   `json:"default_policy"`
		RuleURLs      []string `json:"rule_urls"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &cats); err != nil {
		t.Fatal(err)
	}
	if len(cats) != len(UnifiedCategories) {
		t.Fatalf("categories length = %d want %d", len(cats), len(UnifiedCategories))
	}
	var tg []string
	for _, c := range cats {
		if c.Name == "Telegram" {
			tg = c.RuleURLs
		}
	}
	if len(tg) == 0 {
		t.Fatal("Telegram category missing")
	}
	if !strings.Contains(tg[0], "RULE-SET,") || !strings.Contains(tg[0], "/Telegram.list,") {
		t.Fatalf("Telegram rule_urls = %v", tg)
	}
}

func TestRoutes_SubscriptionLifecycle(t *testing.T) {
	p, s := testPlugin(t)
	ctx := context.Background()
	tid, err := s.CreateTemplate(ctx, "t1", false, `{"final":"PROXY"}`)
	if err != nil {
		t.Fatal(err)
	}

	// create
	w := p.do("POST", "/subscriptions", map[string]any{"name": "mysub", "template_id": tid})
	if w.Code != 200 {
		t.Fatalf("create sub: want 200 got %d body=%s", w.Code, w.Body.String())
	}
	var sub struct {
		ID         int64  `json:"id"`
		Name       string `json:"name"`
		Token      string `json:"token"`
		TemplateID int64  `json:"template_id"`
		Enabled    bool   `json:"enabled"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &sub); err != nil {
		t.Fatal(err)
	}
	if sub.ID == 0 || sub.Name != "mysub" || sub.Token == "" {
		t.Fatalf("created sub = %+v", sub)
	}
	idStr := strconv.FormatInt(sub.ID, 10)

	// empty name → 400
	if w := p.do("POST", "/subscriptions", map[string]any{"name": "", "template_id": tid}); w.Code != 400 {
		t.Fatalf("empty name: want 400 got %d", w.Code)
	}

	// rotate-token → token changes
	w = p.do("POST", "/subscriptions/"+idStr+"/rotate-token", nil)
	if w.Code != 200 {
		t.Fatalf("rotate: want 200 got %d body=%s", w.Code, w.Body.String())
	}
	var rot struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &rot); err != nil {
		t.Fatal(err)
	}
	if rot.Token == "" || rot.Token == sub.Token {
		t.Fatalf("rotated token = %q (old %q)", rot.Token, sub.Token)
	}

	// set inbounds
	w = p.do("PUT", "/subscriptions/"+idStr+"/inbounds", map[string]any{
		"inbounds": []map[string]any{{"source": "xray", "inbound_id": 7}},
	})
	if w.Code != 204 {
		t.Fatalf("set inbounds: want 204 got %d body=%s", w.Code, w.Body.String())
	}

	// get inbounds round-trip
	w = p.do("GET", "/subscriptions/"+idStr+"/inbounds", nil)
	if w.Code != 200 {
		t.Fatalf("get inbounds: want 200 got %d", w.Code)
	}
	var sels []Selection
	if err := json.Unmarshal(w.Body.Bytes(), &sels); err != nil {
		t.Fatal(err)
	}
	if len(sels) != 1 || sels[0].Source != "xray" || sels[0].InboundID != 7 {
		t.Fatalf("inbounds round-trip = %+v", sels)
	}

	// list subscriptions
	w = p.do("GET", "/subscriptions", nil)
	if w.Code != 200 {
		t.Fatalf("list subs: want 200 got %d", w.Code)
	}
	var list []map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 {
		t.Fatalf("list len = %d", len(list))
	}

	// patch
	w = p.do("PATCH", "/subscriptions/"+idStr, map[string]any{
		"name": "renamed", "template_id": tid, "enabled": false,
	})
	if w.Code != 200 {
		t.Fatalf("patch sub: want 200 got %d body=%s", w.Code, w.Body.String())
	}
	got, err := s.Subscription(ctx, sub.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "renamed" || got.Enabled {
		t.Fatalf("patched sub = %+v", got)
	}

	// delete
	w = p.do("DELETE", "/subscriptions/"+idStr, nil)
	if w.Code != 204 {
		t.Fatalf("delete sub: want 204 got %d", w.Code)
	}
	if _, err := s.Subscription(ctx, sub.ID); err == nil {
		t.Fatal("subscription still present after delete")
	}
}

func TestRoutes_PreviewTemplate(t *testing.T) {
	p, _ := testPlugin(t)

	// valid → 200 with rendered text
	w := p.do("POST", "/templates/preview", map[string]any{
		"rules_json": `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`,
		"target":     "surge",
	})
	if w.Code != 200 {
		t.Fatalf("preview: want 200 got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "RULE-SET,") || !strings.Contains(w.Body.String(), "[Proxy]") {
		t.Fatalf("preview body:\n%s", w.Body.String())
	}

	// unknown target → 400
	if w := p.do("POST", "/templates/preview", map[string]any{
		"rules_json": `{"final":"PROXY"}`, "target": "quantumultx",
	}); w.Code != 400 {
		t.Fatalf("bad target: want 400 got %d body=%s", w.Code, w.Body.String())
	}

	// malformed rules → 400
	if w := p.do("POST", "/templates/preview", map[string]any{
		"rules_json": `{"categories":[{"name":"Nope","policy":"PROXY"}]}`, "target": "surge",
	}); w.Code != 400 {
		t.Fatalf("bad rules: want 400 got %d body=%s", w.Code, w.Body.String())
	}
}

func TestRoutes_Preview(t *testing.T) {
	p, s := testPlugin(t)
	ctx := context.Background()
	s.DB.MustExec(`CREATE TABLE xray_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, port INTEGER, role TEXT, protocol TEXT,
		uuid TEXT, sni TEXT, public_key TEXT, short_id TEXT, ws_path TEXT, ss_method TEXT, ss_password TEXT)`)
	s.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'jp','1.1.1.1','JP')`)
	s.DB.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid,sni,public_key,short_id)
	               VALUES (10,1,'r',443,'landing','vless-reality','u','sni','PBK','aa')`)
	tid, _ := s.CreateTemplate(ctx, "t", false, `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`)
	sub, _ := s.CreateSubscription(ctx, "s", tid)
	_ = s.SetInbounds(ctx, sub.ID, []Selection{{Source: "xray", InboundID: 10}})
	idStr := strconv.FormatInt(sub.ID, 10)

	w := p.do("GET", "/subscriptions/"+idStr+"/preview?target=surge", nil)
	if w.Code != 200 {
		t.Fatalf("preview: want 200 got %d body=%s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "RULE-SET,") {
		t.Fatalf("preview body:\n%s", w.Body.String())
	}

	// bad target → 400
	if w := p.do("GET", "/subscriptions/"+idStr+"/preview?target=quantumultx", nil); w.Code != 400 {
		t.Fatalf("bad target: want 400 got %d", w.Code)
	}

	// not found → 404
	if w := p.do("GET", "/subscriptions/999999/preview?target=surge", nil); w.Code != 404 {
		t.Fatalf("missing sub: want 404 got %d", w.Code)
	}
}
