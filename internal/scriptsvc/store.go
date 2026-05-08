package scriptsvc

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"
)

type Param struct {
	Name     string `json:"name"`
	Label    string `json:"label,omitempty"`
	Required bool   `json:"required,omitempty"`
	Default  string `json:"default,omitempty"`
}

type Script struct {
	ID              int64     `db:"id" json:"id"`
	Name            string    `db:"name" json:"name"`
	Description     string    `db:"description" json:"description"`
	Content         string    `db:"content" json:"content"`
	ParamsJSON      string    `db:"params_json" json:"-"`
	DefaultTimeoutS *int      `db:"default_timeout_s" json:"default_timeout_s,omitempty"`
	CreatedAt       time.Time `db:"created_at" json:"created_at"`
	UpdatedAt       time.Time `db:"updated_at" json:"updated_at"`
	Params          []Param   `db:"-" json:"params"`
}

type Store struct {
	DB  *sqlx.DB
	Now func() time.Time
}

func (s *Store) Create(ctx context.Context, sc *Script) (int64, error) {
	now := s.Now().UTC()
	if sc.ParamsJSON == "" {
		sc.ParamsJSON = "[]"
	}
	res, err := s.DB.ExecContext(ctx,
		`INSERT INTO scripts(name, description, content, params_json, default_timeout_s, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sc.Name, sc.Description, sc.Content, sc.ParamsJSON, sc.DefaultTimeoutS, now, now)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) Update(ctx context.Context, sc *Script) error {
	if sc.ID == 0 {
		return errors.New("missing id")
	}
	if sc.ParamsJSON == "" {
		sc.ParamsJSON = "[]"
	}
	now := s.Now().UTC()
	_, err := s.DB.ExecContext(ctx,
		`UPDATE scripts SET name=?, description=?, content=?, params_json=?, default_timeout_s=?, updated_at=? WHERE id=?`,
		sc.Name, sc.Description, sc.Content, sc.ParamsJSON, sc.DefaultTimeoutS, now, sc.ID)
	return err
}

func (s *Store) Delete(ctx context.Context, id int64) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM scripts WHERE id=?`, id)
	return err
}

func (s *Store) Get(ctx context.Context, id int64) (*Script, error) {
	var sc Script
	if err := s.DB.GetContext(ctx, &sc, `SELECT * FROM scripts WHERE id=?`, id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errors.New("not found")
		}
		return nil, err
	}
	return &sc, nil
}

func (s *Store) List(ctx context.Context) ([]Script, error) {
	var out []Script
	err := s.DB.SelectContext(ctx, &out, `SELECT * FROM scripts ORDER BY name`)
	return out, err
}
