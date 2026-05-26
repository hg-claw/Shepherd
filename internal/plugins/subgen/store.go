package subgen

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"time"

	"github.com/jmoiron/sqlx"
)

// Store provides data-access for subgen templates and subscriptions.
type Store struct {
	DB  *sqlx.DB
	Now func() time.Time
}

// Template is a row in subgen_templates.
type Template struct {
	ID        int64     `db:"id"`
	Name      string    `db:"name"`
	Builtin   bool      `db:"builtin"`
	RulesJSON string    `db:"rules_json"`
	CreatedAt time.Time `db:"created_at"`
	UpdatedAt time.Time `db:"updated_at"`
}

// Subscription is a row in subgen_subscriptions.
type Subscription struct {
	ID         int64     `db:"id"`
	Name       string    `db:"name"`
	Token      string    `db:"token"`
	TemplateID int64     `db:"template_id"`
	Enabled    bool      `db:"enabled"`
	CreatedAt  time.Time `db:"created_at"`
	UpdatedAt  time.Time `db:"updated_at"`
}

// Selection represents a row in subgen_subscription_inbounds.
type Selection struct {
	Source    string `db:"source"     json:"source"`
	InboundID int64  `db:"inbound_id" json:"inbound_id"`
}

// newToken generates 18 random bytes hex-encoded (36-char string).
func newToken() string {
	b := make([]byte, 18)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// now returns the current UTC time via the injected clock or time.Now.
func (s *Store) now() time.Time {
	if s.Now == nil {
		return time.Now().UTC()
	}
	return s.Now().UTC()
}

// ─── Templates ───────────────────────────────────────────────────────────────

// CreateTemplate inserts a new template and returns its id.
func (s *Store) CreateTemplate(ctx context.Context, name string, builtin bool, rulesJSON string) (int64, error) {
	now := s.now()
	var id int64
	if err := s.DB.QueryRowxContext(ctx, `
		INSERT INTO subgen_templates (name, builtin, rules_json, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id`,
		name, builtin, rulesJSON, now, now).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

// UpdateTemplate updates name and rules_json for a non-builtin template.
func (s *Store) UpdateTemplate(ctx context.Context, id int64, name, rulesJSON string) error {
	now := s.now()
	_, err := s.DB.ExecContext(ctx, `
		UPDATE subgen_templates
		SET name=$1, rules_json=$2, updated_at=$3
		WHERE id=$4 AND builtin=false`,
		name, rulesJSON, now, id)
	return err
}

// DeleteTemplate deletes a non-builtin template.
func (s *Store) DeleteTemplate(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM subgen_templates WHERE id=$1 AND builtin=false`, id)
	return err
}

// ListTemplates returns all templates ordered builtin-first then by id.
func (s *Store) ListTemplates(ctx context.Context) ([]Template, error) {
	var rows []Template
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT id, name, builtin, rules_json, created_at, updated_at
		 FROM subgen_templates
		 ORDER BY builtin DESC, id`)
	return rows, err
}

// Template returns a single template by id.
func (s *Store) Template(ctx context.Context, id int64) (Template, error) {
	var t Template
	err := s.DB.GetContext(ctx, &t,
		`SELECT id, name, builtin, rules_json, created_at, updated_at
		 FROM subgen_templates WHERE id=$1`, id)
	return t, err
}

// TemplateByName returns a builtin template by name.
func (s *Store) TemplateByName(ctx context.Context, name string) (Template, error) {
	var t Template
	err := s.DB.GetContext(ctx, &t,
		`SELECT id, name, builtin, rules_json, created_at, updated_at
		 FROM subgen_templates WHERE name=$1 AND builtin=true`, name)
	return t, err
}

// ─── Subscriptions ───────────────────────────────────────────────────────────

// CreateSubscription inserts a new subscription with a generated token.
func (s *Store) CreateSubscription(ctx context.Context, name string, templateID int64) (Subscription, error) {
	now := s.now()
	token := newToken()
	var id int64
	if err := s.DB.QueryRowxContext(ctx, `
		INSERT INTO subgen_subscriptions (name, token, template_id, enabled, created_at, updated_at)
		VALUES ($1, $2, $3, 1, $4, $5)
		RETURNING id`,
		name, token, templateID, now, now).Scan(&id); err != nil {
		return Subscription{}, err
	}
	return s.Subscription(ctx, id)
}

// UpdateSubscription updates the mutable fields of a subscription.
func (s *Store) UpdateSubscription(ctx context.Context, id int64, name string, templateID int64, enabled bool) error {
	now := s.now()
	_, err := s.DB.ExecContext(ctx, `
		UPDATE subgen_subscriptions
		SET name=$1, template_id=$2, enabled=$3, updated_at=$4
		WHERE id=$5`,
		name, templateID, enabled, now, id)
	return err
}

// DeleteSubscription deletes a subscription (cascade removes inbounds).
func (s *Store) DeleteSubscription(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx,
		`DELETE FROM subgen_subscriptions WHERE id=$1`, id)
	return err
}

// RotateToken replaces the token of a subscription with a freshly generated one.
func (s *Store) RotateToken(ctx context.Context, id int64) error {
	now := s.now()
	_, err := s.DB.ExecContext(ctx, `
		UPDATE subgen_subscriptions SET token=$1, updated_at=$2 WHERE id=$3`,
		newToken(), now, id)
	return err
}

// ListSubscriptions returns all subscriptions ordered by id.
func (s *Store) ListSubscriptions(ctx context.Context) ([]Subscription, error) {
	var rows []Subscription
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT id, name, token, template_id, enabled, created_at, updated_at
		 FROM subgen_subscriptions ORDER BY id`)
	return rows, err
}

// Subscription returns a single subscription by id.
func (s *Store) Subscription(ctx context.Context, id int64) (Subscription, error) {
	var sub Subscription
	err := s.DB.GetContext(ctx, &sub,
		`SELECT id, name, token, template_id, enabled, created_at, updated_at
		 FROM subgen_subscriptions WHERE id=$1`, id)
	return sub, err
}

// SubscriptionByToken looks up a subscription by its public token.
func (s *Store) SubscriptionByToken(ctx context.Context, token string) (Subscription, error) {
	var sub Subscription
	err := s.DB.GetContext(ctx, &sub,
		`SELECT id, name, token, template_id, enabled, created_at, updated_at
		 FROM subgen_subscriptions WHERE token=$1`, token)
	return sub, err
}

// ─── Inbounds ────────────────────────────────────────────────────────────────

// SetInbounds replaces the inbound selections for a subscription atomically.
func (s *Store) SetInbounds(ctx context.Context, subID int64, sels []Selection) error {
	tx, err := s.DB.BeginTxx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM subgen_subscription_inbounds WHERE subscription_id=$1`, subID); err != nil {
		return err
	}
	for _, sel := range sels {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO subgen_subscription_inbounds (subscription_id, source, inbound_id)
			 VALUES ($1, $2, $3)`,
			subID, sel.Source, sel.InboundID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// InboundsFor returns the inbound selections for a subscription.
func (s *Store) InboundsFor(ctx context.Context, subID int64) ([]Selection, error) {
	var rows []Selection
	err := s.DB.SelectContext(ctx, &rows,
		`SELECT source, inbound_id
		 FROM subgen_subscription_inbounds
		 WHERE subscription_id=$1
		 ORDER BY source, inbound_id`, subID)
	return rows, err
}
