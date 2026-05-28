package subgen

import (
	"context"
	"testing"
)

func TestCollectNodes_MapsAndSkipsMissingHost(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	// xray_inbounds table — minimal columns collect.go selects
	d.MustExec(`CREATE TABLE xray_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, protocol TEXT,
		uuid TEXT, sni TEXT, public_key TEXT, short_id TEXT, ws_path TEXT, ss_method TEXT, ss_password TEXT)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'tokyo','1.2.3.4','JP')`)
	d.MustExec(`INSERT INTO servers(id,name,country_code) VALUES (2,'nohost','US')`) // ssh_host NULL
	d.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid,sni,public_key,short_id)
	            VALUES (10,1,'r',443,'landing','vless-reality','u','sni','PBK','aa')`)
	d.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid)
	            VALUES (11,2,'r',443,'landing','vless-reality','u')`)

	nodes, warns, err := CollectNodes(ctx, d, []Selection{
		{Source: "xray", InboundID: 10},
		{Source: "xray", InboundID: 11},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(nodes) != 1 || nodes[0].Server != "1.2.3.4" {
		t.Fatalf("nodes = %+v", nodes)
	}
	if len(warns) != 1 {
		t.Fatalf("expected 1 skip warning, got %v", warns)
	}
}

func TestCollectNodes_Singbox(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`CREATE TABLE singbox_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, relay_mode TEXT, protocol TEXT,
		uuid TEXT, flow TEXT, password TEXT, sni TEXT, reality_public_key TEXT, reality_short_id TEXT,
		transport_path TEXT, transport_host TEXT, ss_method TEXT, extra_json TEXT, upstream_inbound_id INTEGER)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'hk','9.9.9.9','HK')`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,password,sni,extra_json)
	            VALUES (20,1,'h',443,'landing','proxy','hysteria2','pw','h.example.com','{"up_mbps":100}')`)
	nodes, warns, err := CollectNodes(ctx, d, []Selection{{Source: "singbox", InboundID: 20}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(nodes) != 1 || nodes[0].Protocol != "hysteria2" || nodes[0].Server != "9.9.9.9" {
		t.Fatalf("nodes=%+v warns=%v", nodes, warns)
	}
}

func TestCollectNodes_SkipsForwardRelay(t *testing.T) {
	// forward relay with missing upstream is skipped
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`CREATE TABLE singbox_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, relay_mode TEXT, protocol TEXT,
		uuid TEXT, flow TEXT, password TEXT, sni TEXT, reality_public_key TEXT, reality_short_id TEXT,
		transport_path TEXT, transport_host TEXT, ss_method TEXT, extra_json TEXT, upstream_inbound_id INTEGER)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'hk','9.9.9.9','HK')`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol)
	            VALUES (30,1,'fwd',443,'relay','forward','hysteria2')`)
	nodes, warns, err := CollectNodes(ctx, d, []Selection{{Source: "singbox", InboundID: 30}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(nodes) != 0 {
		t.Fatalf("expected 0 nodes for forward relay, got %+v", nodes)
	}
	if len(warns) != 1 {
		t.Fatalf("expected 1 skip warning, got %v", warns)
	}
}

func TestCollectNodes_ForwardRelayUsesLandingCreds(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`CREATE TABLE singbox_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, relay_mode TEXT, protocol TEXT,
		uuid TEXT, flow TEXT, password TEXT, sni TEXT, reality_public_key TEXT, reality_short_id TEXT,
		transport_path TEXT, transport_host TEXT, ss_method TEXT, extra_json TEXT, upstream_inbound_id INTEGER)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'jp','1.1.1.1','JP')`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (2,'hk','2.2.2.2','HK')`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,uuid,sni,reality_public_key,reality_short_id)
	            VALUES (40,1,'land',8443,'landing','proxy','vless-reality','LU','landing.example.com','LPBK','ab')`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,upstream_inbound_id)
	            VALUES (41,2,'rly',443,'relay','forward','vless-reality',40)`)

	nodes, warns, err := CollectNodes(ctx, d, []Selection{{Source: "singbox", InboundID: 41}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warns: %v", warns)
	}
	if len(nodes) != 1 {
		t.Fatalf("expected 1 node, got %+v", nodes)
	}
	n := nodes[0]
	if n.Server != "2.2.2.2" || n.Port != 443 {
		t.Errorf("relay endpoint: got %s:%d", n.Server, n.Port)
	}
	if n.Protocol != "vless" || n.UUID != "LU" || n.SNI != "landing.example.com" || n.RealityPublicKey != "LPBK" || n.RealityShortID != "ab" {
		t.Errorf("relay should use landing creds: %+v", n)
	}
}

func TestCollectNodes_UsesAlias(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	d := s.DB
	d.MustExec(`CREATE TABLE xray_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, protocol TEXT,
		uuid TEXT, sni TEXT, public_key TEXT, short_id TEXT, ws_path TEXT, ss_method TEXT, ss_password TEXT)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'Tokyo','1.2.3.4','US')`)
	d.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,alias,port,role,protocol,uuid,sni,public_key,short_id)
	            VALUES (10,1,'r','🇭🇰 HK Custom',443,'landing','vless-reality','u','sni','PBK','aa')`)

	nodes, warns, err := CollectNodes(ctx, d, []Selection{{Source: "xray", InboundID: 10}})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(warns) != 0 {
		t.Fatalf("unexpected warns: %v", warns)
	}
	if len(nodes) != 1 {
		t.Fatalf("expected 1 node, got %d: %+v", len(nodes), nodes)
	}
	if nodes[0].Name != "🇭🇰 HK Custom" {
		t.Fatalf("expected Name %q, got %q", "🇭🇰 HK Custom", nodes[0].Name)
	}
}

func TestCollectNodes_UnknownSource(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	nodes, warns, err := CollectNodes(ctx, s.DB, []Selection{
		{Source: "bogus", InboundID: 99},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(nodes) != 0 {
		t.Fatalf("expected 0 nodes, got %v", nodes)
	}
	if len(warns) != 1 {
		t.Fatalf("expected 1 warning, got %v", warns)
	}
}
