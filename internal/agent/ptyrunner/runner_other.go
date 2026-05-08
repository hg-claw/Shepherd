//go:build !linux && !darwin

package ptyrunner

import (
	"context"
	"errors"
)

type Sender interface {
	SendBinary(sid string, kind byte, p []byte) error
	SendExit(sid string, code int)
}

type SpawnOpts struct {
	SID  string
	Kind string
	User string
	Rows int
	Cols int
	Term string
	Exec string
	Env  map[string]string
}

type Runner struct{}

func Spawn(_ context.Context, _ SpawnOpts, _ Sender) (*Runner, error) {
	return nil, errors.New("ptyrunner only supported on linux/darwin")
}
func (r *Runner) Write(_ []byte) error  { return errors.New("unsupported") }
func (r *Runner) Resize(_, _ int) error { return errors.New("unsupported") }
func (r *Runner) Close(_ string)        {}
