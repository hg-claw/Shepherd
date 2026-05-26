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
