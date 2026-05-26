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
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, port INTEGER, role TEXT, protocol TEXT,
		uuid TEXT, sni TEXT, public_key TEXT, short_id TEXT, ws_path TEXT, ss_method TEXT, ss_password TEXT)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'tokyo','1.2.3.4','JP')`)
	d.MustExec(`INSERT INTO servers(id,name,country_code) VALUES (2,'nohost','US')`) // ssh_host NULL
	d.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid,sni,public_key,short_id)
	            VALUES (10,1,'r',443,'landing','vless-reality','u','sni','PBK','aa')`)
	d.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid)
	            VALUES (11,2,'r',443,'landing','vless-reality','u')`)

	nodes, warns := CollectNodes(ctx, d, []Selection{
		{Source: "xray", InboundID: 10},
		{Source: "xray", InboundID: 11},
	})
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
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, port INTEGER, role TEXT, relay_mode TEXT, protocol TEXT,
		uuid TEXT, flow TEXT, password TEXT, sni TEXT, reality_public_key TEXT, reality_short_id TEXT,
		transport_path TEXT, transport_host TEXT, ss_method TEXT, extra_json TEXT)`)
	d.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'hk','9.9.9.9','HK')`)
	d.MustExec(`INSERT INTO singbox_inbounds(id,server_id,tag,port,role,relay_mode,protocol,password,sni,extra_json)
	            VALUES (20,1,'h',443,'landing','proxy','hysteria2','pw','h.example.com','{"up_mbps":100}')`)
	nodes, warns := CollectNodes(ctx, d, []Selection{{Source: "singbox", InboundID: 20}})
	if len(nodes) != 1 || nodes[0].Protocol != "hysteria2" || nodes[0].Server != "9.9.9.9" {
		t.Fatalf("nodes=%+v warns=%v", nodes, warns)
	}
}
