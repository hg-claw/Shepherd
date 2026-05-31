package subgen

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestService_GenerateByToken(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	// minimal xray_inbounds table (collect.go reads these columns)
	s.DB.MustExec(`CREATE TABLE xray_inbounds (
		id INTEGER PRIMARY KEY, server_id INTEGER, tag TEXT, alias TEXT, port INTEGER, role TEXT, protocol TEXT,
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

func TestService_PreviewTemplate(t *testing.T) {
	svc := &Service{Now: time.Now, RulesetBase: DefaultRulesetBase}
	rules := `{"categories":[{"name":"Telegram","policy":"PROXY"}],"final":"PROXY"}`

	out, ct, err := svc.PreviewTemplate(rules, "surge")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(ct, "text/plain") {
		t.Fatalf("content-type=%s", ct)
	}
	// Sample nodes render into [Proxy], the category becomes a RULE-SET line,
	// and the template's fixed FINAL rule trails. Sample nodes never get skipped.
	for _, want := range []string{"[Proxy]", "= trojan,", "= ss,", "RULE-SET,", "FINAL,Others"} {
		if !strings.Contains(out, want) {
			t.Fatalf("preview missing %q:\n%s", want, out)
		}
	}
	// The two sample nodes (🇺🇸 / 🇭🇰) appear in [Proxy] and in each category group.
	if !strings.Contains(out, "🇺🇸") || !strings.Contains(out, "🇭🇰") {
		t.Fatalf("expected sample-node flags in output:\n%s", out)
	}

	// clash target now renders YAML
	cy, _, err := svc.PreviewTemplate(rules, "clash")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cy, "proxies:") || !strings.Contains(cy, "MATCH,") {
		t.Fatalf("clash preview:\n%s", cy)
	}

	// unknown target → ErrBadTarget
	if _, _, err := svc.PreviewTemplate(rules, "quantumultx"); !errors.Is(err, ErrBadTarget) {
		t.Fatalf("want ErrBadTarget got %v", err)
	}
	// malformed rules (unknown category) → a parse error, not ErrBadTarget
	if _, _, err := svc.PreviewTemplate(`{"categories":[{"name":"Nope","policy":"PROXY"}]}`, "surge"); err == nil {
		t.Fatal("expected error for unknown category")
	}
}

func TestService_PreviewTemplate_CustomNodes(t *testing.T) {
	svc := &Service{Now: time.Now, RulesetBase: DefaultRulesetBase}
	rules := `{"final":"PROXY","custom_nodes":"trojan://pw@9.9.9.9:443?sni=x.com#MyNode"}`
	for _, target := range []string{"surge", "clash"} {
		out, _, err := svc.PreviewTemplate(rules, target)
		if err != nil {
			t.Fatalf("%s: %v", target, err)
		}
		if !strings.Contains(out, "MyNode") {
			t.Fatalf("%s preview missing custom node:\n%s", target, out)
		}
	}
}

func TestService_UnknownTokenAndTarget(t *testing.T) {
	s := newStore(t)
	svc := &Service{Store: s, Now: time.Now}
	if _, _, err := svc.Generate(context.Background(), "nope", "surge"); err == nil {
		t.Fatal("expected error for unknown token")
	}
	// bad target with any token string → ErrBadTarget
	if _, _, err := svc.Generate(context.Background(), "whatever", "quantumultx"); err == nil {
		t.Fatal("expected error for unknown target")
	}
}
