package singbox

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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
