package subgen

import (
	"context"
	"errors"
	"fmt"
	"time"
)

var ErrNotFound = errors.New("subscription not found")
var ErrBadTarget = errors.New("unknown target")

type Service struct {
	Store       *Store
	Now         func() time.Time
	RulesetBase string // empty → DefaultRulesetBase
	PublicURL   string // base for the #!MANAGED-CONFIG self-URL
}

func (s *Service) base() string {
	if s.RulesetBase != "" {
		return s.RulesetBase
	}
	return DefaultRulesetBase
}

func (s *Service) Generate(ctx context.Context, token, target string) (body, contentType string, err error) {
	r, ok := rendererFor(target)
	if !ok {
		return "", "", ErrBadTarget
	}
	sub, err := s.Store.SubscriptionByToken(ctx, token)
	if err != nil || !sub.Enabled {
		return "", "", ErrNotFound
	}
	tpl, err := s.Store.Template(ctx, sub.TemplateID)
	if err != nil {
		return "", "", ErrNotFound
	}
	spec, err := ParseTemplate(tpl.RulesJSON)
	if err != nil {
		return "", "", err
	}
	sels, _ := s.Store.InboundsFor(ctx, sub.ID)
	nodes, _, err := CollectNodes(ctx, s.Store.DB, sels)
	if err != nil {
		return "", "", err
	}
	im := Assemble(nodes, spec, target, s.base())
	subURL := fmt.Sprintf("%s/sub/%s?target=%s", s.PublicURL, token, target)
	return r.Render(im, subURL), "text/plain; charset=utf-8", nil
}

// PreviewTemplate renders rulesJSON against a fixed set of sample nodes so the
// admin can see the generated config while editing a template — before it is
// saved or attached to any subscription. The sample nodes span two countries so
// category groups show multiple members. All failures are client-side:
// ErrBadTarget for an unknown target, or a parse error for malformed rulesJSON.
func (s *Service) PreviewTemplate(rulesJSON, target string) (body, contentType string, err error) {
	r, ok := rendererFor(target)
	if !ok {
		return "", "", ErrBadTarget
	}
	spec, err := ParseTemplate(rulesJSON)
	if err != nil {
		return "", "", err
	}
	im := Assemble(sampleNodes(), spec, target, s.base())
	subURL := fmt.Sprintf("%s/sub/PREVIEW?target=%s", s.PublicURL, target)
	return r.Render(im, subURL), "text/plain; charset=utf-8", nil
}

// sampleNodes returns placeholder nodes used only by PreviewTemplate. They span
// two countries and use protocols every renderer supports, so a preview is
// never empty regardless of the chosen target.
func sampleNodes() []Node {
	return []Node{
		{Name: nodeName("US", "sample", "trojan"), Protocol: "trojan", Server: "us.example", Port: 443, Country: "US", Password: "sample", SNI: "us.example"},
		{Name: nodeName("HK", "sample", "shadowsocks"), Protocol: "shadowsocks", Server: "hk.example", Port: 8388, Country: "HK", SSMethod: "aes-128-gcm", Password: "sample"},
	}
}
