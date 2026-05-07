package filehandler

import (
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
)

var ErrPathNotAllowed = errors.New("path not allowed")

type Sandbox struct {
	Enabled bool
	Allowed []string // absolute, canonicalized
}

func (s *Sandbox) Check(p string, mustExist bool) error {
	if !s.Enabled {
		return nil
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) && !mustExist {
			parent, e2 := filepath.EvalSymlinks(filepath.Dir(abs))
			if e2 != nil {
				return e2
			}
			resolved = filepath.Join(parent, filepath.Base(abs))
		} else {
			return err
		}
	}
	cleaned := filepath.Clean(resolved)
	for _, raw := range s.Allowed {
		ap := filepath.Clean(raw)
		if cleaned == ap || strings.HasPrefix(cleaned, ap+string(filepath.Separator)) {
			return nil
		}
	}
	return ErrPathNotAllowed
}
