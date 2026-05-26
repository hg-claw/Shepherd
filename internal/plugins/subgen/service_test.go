package subgen

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestService_GenerateByToken(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	// minimal xray_inbounds table (collect.go reads these columns)
	s.DB.MustExec(`CREATE TABLE xray_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, port INTEGER, role TEXT, protocol TEXT,
		uuid TEXT, sni TEXT, public_key TEXT, short_id TEXT, ws_path TEXT, ss_method TEXT, ss_password TEXT)`)
	s.DB.MustExec(`INSERT INTO servers(id,name,ssh_host,country_code) VALUES (1,'jp','1.1.1.1','JP')`)
	s.DB.MustExec(`INSERT INTO xray_inbounds(id,server_id,tag,port,role,protocol,uuid,sni,public_key,short_id)
	               VALUES (10,1,'r',443,'landing','vless-reality','u','sni','PBK','aa')`)
	tid, _ := s.CreateTemplate(ctx, "t", false, `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`)
	sub, _ := s.CreateSubscription(ctx, "s", tid)
	_ = s.SetInbounds(ctx, sub.ID, []Selection{{Source: "xray", InboundID: 10}})

	svc := &Service{Store: s, Now: time.Now, RulesetBase: DefaultRulesetBase}
	out, ct, err := svc.Generate(ctx, sub.Token, "surge")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ct, "text/plain") {
		t.Fatalf("content-type=%s", ct)
	}
	if !strings.Contains(out, "vless, 1.1.1.1, 443") || !strings.Contains(out, "RULE-SET,") {
		t.Fatalf("output:\n%s", out)
	}
}

func TestService_UnknownTokenAndTarget(t *testing.T) {
	s := newStore(t)
	svc := &Service{Store: s, Now: time.Now}
	if _, _, err := svc.Generate(context.Background(), "nope", "surge"); err == nil {
		t.Fatal("expected error for unknown token")
	}
	// bad target with any token string → ErrBadTarget
	if _, _, err := svc.Generate(context.Background(), "whatever", "clash"); err == nil {
		t.Fatal("expected error for unknown target")
	}
}
