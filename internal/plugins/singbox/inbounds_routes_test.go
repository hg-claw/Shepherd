package singbox

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

func newRouteDeps(t *testing.T) plugins.Deps {
	t.Helper()
	d := newDeployTestDB(t)
	// Disable the production fire-and-forget AssembleAndDeploy goroutine
	// for the duration of the test. The real one races against t.Cleanup
	// closing the in-memory DB (caught by `go test -race`).
	prev := asyncDeploy
	asyncDeploy = func(_ plugins.Deps, _ int64) {}
	t.Cleanup(func() { asyncDeploy = prev })
	return plugins.Deps{DB: d, HostExec: &fakeSBHostExec{}}
}

func postJSON(t *testing.T, handler http.HandlerFunc, body any) *httptest.ResponseRecorder {
	t.Helper()
	b, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/inbounds", bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	handler(rr, req)
	return rr
}

func TestRoute_CreateLanding(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vless-reality",
		"uuid":                    "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
		"reality_private_key":     "PRIV",
		"reality_public_key":      "PUB",
		"reality_short_id":        "aabb1122",
		"reality_handshake_server": "www.icloud.com", "reality_handshake_port": 443,
		"sni": "www.icloud.com",
	})
	if rr.Code != 201 {
		t.Fatalf("want 201, got %d: %s", rr.Code, rr.Body)
	}
	var resp map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if resp["tag"] == nil || resp["tag"] == "" {
		t.Errorf("tag missing: %v", resp)
	}
	if resp["reality_private_key"] != "[REDACTED]" {
		t.Errorf("reality_private_key not redacted: %v", resp["reality_private_key"])
	}
}

func TestRoute_RejectsPortConflict(t *testing.T) {
	deps := newRouteDeps(t)
	h := postInboundHandler(deps)
	_ = postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuid1"})
	rr := postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuid2"})
	if rr.Code != 409 {
		t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body)
	}
}

func TestRoute_RejectsClashAPIPort(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 29090, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuid3",
	})
	if rr.Code != 409 {
		t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body)
	}
}

func TestRoute_RejectsRelayWithoutUpstream(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 8443, "role": "relay", "protocol": "vmess-tcp", "uuid": "uuid4",
	})
	if rr.Code != 409 {
		t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body)
	}
}

func TestRoute_RejectsRelayPointingAtRelay(t *testing.T) {
	deps := newRouteDeps(t)
	h := postInboundHandler(deps)
	r1 := postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidL"})
	if r1.Code != 201 {
		t.Fatalf("landing: %d %s", r1.Code, r1.Body)
	}
	var land map[string]any
	_ = json.NewDecoder(r1.Body).Decode(&land)
	landID := int64(land["id"].(float64))

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
		VALUES (2,'s2','2.2.2.2','root',22,?)`, time.Now())
	r2 := postJSON(t, h, map[string]any{
		"server_id": 2, "port": 8443, "role": "relay", "protocol": "vmess-tcp",
		"uuid": "uuidR1", "upstream_inbound_id": landID,
	})
	if r2.Code != 201 {
		t.Fatalf("relay1: %d %s", r2.Code, r2.Body)
	}
	var relay1 map[string]any
	_ = json.NewDecoder(r2.Body).Decode(&relay1)
	relay1ID := int64(relay1["id"].(float64))

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
		VALUES (3,'s3','3.3.3.3','root',22,?)`, time.Now())
	r3 := postJSON(t, h, map[string]any{
		"server_id": 3, "port": 9443, "role": "relay", "protocol": "vmess-tcp",
		"uuid": "uuidR2", "upstream_inbound_id": relay1ID,
	})
	if r3.Code != 409 {
		t.Fatalf("relay→relay must be 409, got %d: %s", r3.Code, r3.Body)
	}
}

func TestRoute_GetByServer(t *testing.T) {
	deps := newRouteDeps(t)
	_ = postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidG",
	})
	req := httptest.NewRequest("GET", "/inbounds?server_id=1", nil)
	rr := httptest.NewRecorder()
	getInboundsHandler(deps)(rr, req)
	if rr.Code != 200 {
		t.Fatalf("get: %d %s", rr.Code, rr.Body)
	}
	var resp []any
	_ = json.NewDecoder(rr.Body).Decode(&resp)
	if len(resp) != 1 {
		t.Fatalf("want 1 inbound, got %d", len(resp))
	}
}

func TestRoute_PatchImmutables(t *testing.T) {
	deps := newRouteDeps(t)
	r := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidP",
	})
	var created map[string]any
	_ = json.NewDecoder(r.Body).Decode(&created)
	id := int64(created["id"].(float64))

	b, _ := json.Marshal(map[string]any{"port": 9443, "role": "relay"})
	req := httptest.NewRequest("PATCH", "/inbounds/"+fmt.Sprint(id), bytes.NewReader(b))
	req.SetPathValue("id", fmt.Sprint(id))
	req.Header.Set("Content-Type", "application/json")
	rr := httptest.NewRecorder()
	patchInboundHandler(deps)(rr, req)
	if rr.Code != 200 {
		t.Fatalf("patch: %d %s", rr.Code, rr.Body)
	}
	var updated map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&updated)
	if updated["port"].(float64) != 9443 {
		t.Errorf("port not updated: %v", updated["port"])
	}
	if updated["role"] != "landing" {
		t.Errorf("role mutated: %v", updated["role"])
	}
}

func TestRoute_DeleteWithDependents(t *testing.T) {
	deps := newRouteDeps(t)
	h := postInboundHandler(deps)
	r := postJSON(t, h, map[string]any{"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp", "uuid": "uuidD"})
	var land map[string]any
	_ = json.NewDecoder(r.Body).Decode(&land)
	landID := int64(land["id"].(float64))

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
		VALUES (2,'s2','2.2.2.2','root',22,?)`, time.Now())
	_ = postJSON(t, h, map[string]any{
		"server_id": 2, "port": 8443, "role": "relay", "protocol": "vmess-tcp",
		"uuid": "uuidDR", "upstream_inbound_id": landID,
	})
	req := httptest.NewRequest("DELETE", "/inbounds/"+fmt.Sprint(landID), nil)
	req.SetPathValue("id", fmt.Sprint(landID))
	rr := httptest.NewRecorder()
	deleteInboundHandler(deps)(rr, req)
	if rr.Code != 409 {
		t.Fatalf("want 409, got %d: %s", rr.Code, rr.Body)
	}
}

func TestRoutes_InboundAlias(t *testing.T) {
	deps := newRouteDeps(t)
	h := postInboundHandler(deps)

	// POST create with alias
	rCreate := postJSON(t, h, map[string]any{
		"server_id": 1, "port": 443, "role": "landing", "protocol": "vmess-tcp",
		"uuid": "uuidAlias1", "alias": "🇸🇬 SG 01",
	})
	if rCreate.Code != 201 {
		t.Fatalf("create: want 201, got %d: %s", rCreate.Code, rCreate.Body)
	}
	var created map[string]any
	_ = json.NewDecoder(rCreate.Body).Decode(&created)
	if created["alias"] != "🇸🇬 SG 01" {
		t.Errorf("create: alias not echoed, got %v", created["alias"])
	}
	id := int64(created["id"].(float64))

	// PATCH alias
	patchBody, _ := json.Marshal(map[string]any{"alias": "🇸🇬 SG renamed"})
	reqPatch := httptest.NewRequest("PATCH", "/inbounds/"+fmt.Sprint(id), bytes.NewReader(patchBody))
	reqPatch.SetPathValue("id", fmt.Sprint(id))
	reqPatch.Header.Set("Content-Type", "application/json")
	rrPatch := httptest.NewRecorder()
	patchInboundHandler(deps)(rrPatch, reqPatch)
	if rrPatch.Code != 200 {
		t.Fatalf("patch: want 200, got %d: %s", rrPatch.Code, rrPatch.Body)
	}

	// GET list and verify alias persisted
	reqGet := httptest.NewRequest("GET", "/inbounds?server_id=1", nil)
	rrGet := httptest.NewRecorder()
	getInboundsHandler(deps)(rrGet, reqGet)
	if rrGet.Code != 200 {
		t.Fatalf("get: want 200, got %d: %s", rrGet.Code, rrGet.Body)
	}
	var list []map[string]any
	_ = json.NewDecoder(rrGet.Body).Decode(&list)
	var found bool
	for _, item := range list {
		if int64(item["id"].(float64)) == id {
			if item["alias"] != "🇸🇬 SG renamed" {
				t.Errorf("list: alias not updated, got %v", item["alias"])
			}
			found = true
			break
		}
	}
	if !found {
		t.Errorf("list: inbound id=%d not found in response", id)
	}
}

func TestIsValidProtocol_Snell(t *testing.T) {
	for _, p := range []string{"snell-v5", "snell-v6"} {
		if !isValidProtocol(p) {
			t.Errorf("isValidProtocol(%q) = false, want true", p)
		}
	}
	if isValidProtocol("snell") {
		t.Error(`isValidProtocol("snell") = true, want false (version must be in the name)`)
	}
}

func TestValidatePostInbound_SnellRequiresPassword(t *testing.T) {
	deps := newRouteDeps(t)
	store := &InboundStore{DB: deps.DB}
	body := postInboundBody{ServerID: 1, Port: 8443, Role: "landing", Protocol: "snell-v5"}
	if err := validatePostInbound(context.Background(), store, body); err == nil {
		t.Fatal("expected error when snell psk (password) is empty")
	}
	psk := "test-psk-value"
	body.Password = &psk
	if err := validatePostInbound(context.Background(), store, body); err != nil {
		t.Fatalf("unexpected error with psk set: %v", err)
	}
}

// seedSnellLanding creates a snell-v5 landing on server 1 and returns its id.
// Requires a 1.14 plugin_hosts row (the create handler pre-flights the gate).
func seedSnellLanding(t *testing.T, deps plugins.Deps) int64 {
	t.Helper()
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 8443, "role": "landing", "protocol": "snell-v5",
		"password": "psk-landing",
	})
	if rr.Code != 201 {
		t.Fatalf("seed landing: want 201, got %d: %s", rr.Code, rr.Body)
	}
	var land map[string]any
	_ = json.NewDecoder(rr.Body).Decode(&land)
	return int64(land["id"].(float64))
}

// TestRoute_SnellForwardRelayNeedsNoPSK: forward is the default mode in the
// bulk-relay dialog and deliberately sends no credentials — the row renders
// as {"type":"direct"}, so the psk is never read. Requiring one made the
// out-of-the-box "add relays" action on a snell landing fail outright.
// The relay's own server (2) has no plugin_hosts row at all, which also
// pins the version-gate carve-out: a forward relay must not need 1.14.
func TestRoute_SnellForwardRelayNeedsNoPSK(t *testing.T) {
	deps := newRouteDeps(t)
	seedSnellHost(t, deps.DB, "v1.14.0-beta.2")
	landID := seedSnellLanding(t, deps)

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
		VALUES (2,'s2','2.2.2.2','root',22,?)`, time.Now())
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 2, "port": 9443, "role": "relay", "protocol": "snell-v5",
		"upstream_inbound_id": landID, "relay_mode": "forward",
	})
	if rr.Code != 201 {
		t.Fatalf("forward snell relay without psk must be accepted, got %d: %s", rr.Code, rr.Body)
	}
}

// TestRoute_SnellProxyRelayStillNeedsPSK: a proxy-mode relay really does
// terminate snell on the relay host, so the psk stays mandatory there.
func TestRoute_SnellProxyRelayStillNeedsPSK(t *testing.T) {
	deps := newRouteDeps(t)
	seedSnellHost(t, deps.DB, "v1.14.0-beta.2")
	landID := seedSnellLanding(t, deps)

	deps.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,ssh_user,ssh_port,created_at)
		VALUES (2,'s2','2.2.2.2','root',22,?)`, time.Now())
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 2, "port": 9443, "role": "relay", "protocol": "snell-v5",
		"upstream_inbound_id": landID, "relay_mode": "proxy",
	})
	if rr.Code != 409 {
		t.Fatalf("proxy snell relay without psk must be rejected, got %d: %s", rr.Code, rr.Body)
	}
	if !strings.Contains(rr.Body.String(), "psk") {
		t.Errorf("error must name the missing psk, got: %s", rr.Body)
	}
}

// TestRoute_CreateSnellOnOldHost_409: the deploy-time gate runs inside
// asyncDeploy, whose error is discarded and never lands in
// plugin_hosts.last_error. Without a pre-flight the create 201s and then
// the server's whole config silently stops updating. Assert the create is
// refused up front with the gate's own message.
func TestRoute_CreateSnellOnOldHost_409(t *testing.T) {
	deps := newRouteDeps(t)
	seedSnellHost(t, deps.DB, "1.13.14")
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 8443, "role": "landing", "protocol": "snell-v5",
		"password": "psk-value",
	})
	if rr.Code != 409 {
		t.Fatalf("snell create on a 1.13 host must be 409, got %d: %s", rr.Code, rr.Body)
	}
	body := rr.Body.String()
	for _, want := range []string{"1.14", "snell-v5", "Deploy tab"} {
		if !strings.Contains(body, want) {
			t.Errorf("409 body must mention %q, got: %s", want, body)
		}
	}
}

// TestRoute_CreateSnellNoHostRow_409: no plugin_hosts row means we have no
// evidence the host can run snell — fail closed, same as the deploy gate.
func TestRoute_CreateSnellNoHostRow_409(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 8443, "role": "landing", "protocol": "snell-v6",
		"password": "psk-value",
	})
	if rr.Code != 409 {
		t.Fatalf("snell create with no plugin_hosts row must be 409, got %d: %s", rr.Code, rr.Body)
	}
}

// TestRoute_CreateSnellOnSupportedHost_201: the gate must not block a host
// that is actually on 1.14.
func TestRoute_CreateSnellOnSupportedHost_201(t *testing.T) {
	deps := newRouteDeps(t)
	seedSnellHost(t, deps.DB, "v1.14.0-beta.2")
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 8443, "role": "landing", "protocol": "snell-v5",
		"password": "psk-value",
	})
	if rr.Code != 201 {
		t.Fatalf("snell create on a 1.14 host must be 201, got %d: %s", rr.Code, rr.Body)
	}
}

// TestRoute_CreateNonSnellIgnoresGate: the pre-flight must stay inert for
// every other protocol — no plugin_hosts row exists here at all.
func TestRoute_CreateNonSnellIgnoresGate(t *testing.T) {
	deps := newRouteDeps(t)
	rr := postJSON(t, postInboundHandler(deps), map[string]any{
		"server_id": 1, "port": 8443, "role": "landing", "protocol": "hysteria2",
		"password": "pw",
	})
	if rr.Code != 201 {
		t.Fatalf("non-snell create must be unaffected by the gate, got %d: %s", rr.Code, rr.Body)
	}
}

// seedRealityLanding inserts a vless-reality landing (server 1, already
// created by newDeployTestDB) directly via the store, mirroring the
// construction style in TestAssembleAndDeploy_NoCerts. Returns its id.
func seedRealityLanding(t *testing.T, store *InboundStore) int64 {
	t.Helper()
	id, err := store.Insert(context.Background(), Inbound{
		ServerID: 1, Tag: store.GenerateTag("landing"), Port: 443,
		Role: "landing", Protocol: "vless-reality",
		UUID:                   ptrStr("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
		RealityPrivateKey:      ptrStr("PRIV"),
		RealityPublicKey:       ptrStr("PUB"),
		RealityShortID:         ptrStr("aabb1122"),
		RealityHandshakeServer: ptrStr("www.icloud.com"),
		RealityHandshakePort:   ptrI64(443),
		SNI:                    ptrStr("www.icloud.com"),
	})
	if err != nil {
		t.Fatalf("seed reality landing: %v", err)
	}
	return id
}

func TestValidatePostInbound_ForwardRelayExemptFromRealityCredentials(t *testing.T) {
	ctx := context.Background()
	store := &InboundStore{DB: newDeployTestDB(t), Now: time.Now}
	landingID := seedRealityLanding(t, store)

	// A forward relay renders as a sing-box "direct" inbound — renderInbound
	// short-circuits before the protocol switch, so no reality field is ever
	// read. Demanding them makes the default bulk-relay action fail.
	fwd := postInboundBody{
		ServerID: 2, Port: 8443, Role: "relay", RelayMode: "forward",
		Protocol: "vless-reality", UpstreamInboundID: &landingID,
	}
	if err := validatePostInbound(ctx, store, fwd); err != nil {
		t.Fatalf("forward relay must not require reality credentials, got: %v", err)
	}

	// Proxy relays and landings still must carry them.
	proxy := fwd
	proxy.RelayMode = "proxy"
	if err := validatePostInbound(ctx, store, proxy); err == nil {
		t.Error("proxy relay without reality_private_key must still be rejected")
	}
	landing := postInboundBody{
		ServerID: 2, Port: 8444, Role: "landing", Protocol: "vless-reality",
	}
	if err := validatePostInbound(ctx, store, landing); err == nil {
		t.Error("landing without reality_private_key must still be rejected")
	}
}
