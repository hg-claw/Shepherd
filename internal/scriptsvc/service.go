package scriptsvc

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jmoiron/sqlx"

	"github.com/hg-claw/Shepherd/internal/agentsvc"
	"github.com/hg-claw/Shepherd/internal/audit"
	"github.com/hg-claw/Shepherd/internal/ptysvc"
	"github.com/hg-claw/Shepherd/internal/sessionmux"
)

type Service struct {
	DB    *sqlx.DB
	Store *Store
	PTY   *ptysvc.Service
	Reg   *sessionmux.Registry
	Audit *audit.Writer
	Now   func() time.Time
}

func (s *Service) Run(ctx context.Context, scriptID, adminID int64, args map[string]string, targets []int64) (int64, error) {
	if len(targets) == 0 {
		return 0, errors.New("no targets")
	}
	if len(targets) > 50 {
		return 0, errors.New("too many targets (max 50)")
	}
	sc, err := s.Store.Get(ctx, scriptID)
	if err != nil {
		return 0, err
	}
	var params []Param
	_ = json.Unmarshal([]byte(sc.ParamsJSON), &params)
	rendered, err := Render(sc.Content, params, args)
	if err != nil {
		return 0, err
	}

	now := s.Now().UTC()
	argsJSON, _ := json.Marshal(args)
	var runID int64
	if err := s.DB.QueryRowxContext(ctx,
		`INSERT INTO script_runs(script_id, admin_id, args_json, started_at) VALUES ($1, $2, $3, $4) RETURNING id`,
		scriptID, adminID, string(argsJSON), now).Scan(&runID); err != nil {
		return 0, err
	}

	timeoutS := 0
	if sc.DefaultTimeoutS != nil {
		timeoutS = *sc.DefaultTimeoutS
	}

	for _, tgt := range targets {
		var targetID int64
		if err := s.DB.QueryRowxContext(ctx,
			`INSERT INTO script_run_targets(run_id, server_id, status) VALUES ($1, $2, 'pending') RETURNING id`,
			runID, tgt).Scan(&targetID); err != nil {
			return runID, err
		}

		sess, openErr := s.PTY.Open(ctx, ptysvc.OpenOpts{
			AdminID: adminID, ServerID: tgt, Kind: "script", User: "root",
			Rows: 24, Cols: 80, Term: "xterm-256color",
			Exec: rendered, TimeoutS: timeoutS,
		})
		if errors.Is(openErr, agentsvc.ErrAgentOffline) {
			_, _ = s.DB.Exec(`UPDATE script_run_targets SET status='agent_offline', finished_at=$1 WHERE id=$2`, s.Now().UTC(), targetID)
			continue
		}
		if openErr != nil {
			_, _ = s.DB.Exec(`UPDATE script_run_targets SET status='failed', finished_at=$1 WHERE id=$2`, s.Now().UTC(), targetID)
			continue
		}
		_, _ = s.DB.Exec(
			`UPDATE script_run_targets SET status='running', pty_session_id=$1, started_at=$2 WHERE id=$3`,
			sess.PTYRowID, s.Now().UTC(), targetID)
	}

	s.Audit.Write(ctx, &adminID, nil, "script.run", map[string]any{
		"run_id": runID, "script_id": scriptID, "target_count": len(targets),
		"args": args,
	}, nil)

	go s.checkConverged(runID)
	return runID, nil
}

func (s *Service) OnPTYExit(ptyRowID int64, code int, _ string) {
	var targetID int64
	if err := s.DB.Get(&targetID, `SELECT id FROM script_run_targets WHERE pty_session_id=$1`, ptyRowID); err != nil {
		return
	}
	status := "succeeded"
	if code != 0 {
		status = "failed"
	}
	now := s.Now().UTC()
	_, _ = s.DB.Exec(`UPDATE script_run_targets SET status=$1, exit_code=$2, finished_at=$3 WHERE id=$4`,
		status, code, now, targetID)
	var runID int64
	_ = s.DB.Get(&runID, `SELECT run_id FROM script_run_targets WHERE id=$1`, targetID)
	s.checkConverged(runID)
}

func (s *Service) checkConverged(runID int64) {
	var pending int
	_ = s.DB.Get(&pending,
		`SELECT COUNT(*) FROM script_run_targets WHERE run_id=$1 AND finished_at IS NULL`, runID)
	if pending > 0 {
		return
	}
	_, _ = s.DB.Exec(`UPDATE script_runs SET finished_at=$1 WHERE id=$2 AND finished_at IS NULL`,
		s.Now().UTC(), runID)
}

func (s *Service) Sweep(ctx context.Context) error {
	now := s.Now().UTC()
	if _, err := s.DB.ExecContext(ctx,
		`UPDATE script_run_targets SET status='failed', finished_at=$1 WHERE status IN ('pending','running')`, now); err != nil {
		return err
	}
	_, err := s.DB.ExecContext(ctx,
		`UPDATE script_runs SET finished_at=$1 WHERE finished_at IS NULL`, now)
	return err
}
