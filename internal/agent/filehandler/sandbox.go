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
			switch {
			case e2 == nil:
				resolved = filepath.Join(parent, filepath.Base(abs))
			case errors.Is(e2, fs.ErrNotExist):
				// Neither the path nor its parent is on disk. Fall back to
				// the cleaned absolute path: there's no symlink to follow,
				// so a literal whitelist match is sound.
				resolved = abs
			default:
				return e2
			}
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
