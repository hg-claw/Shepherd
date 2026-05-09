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
		if matchesPrefix(cleaned, ap) {
			return nil
		}
		// Also try the resolved version of the allowed path. Server settings
		// commonly list `/tmp`, but on macOS that's a symlink to `/private/tmp`;
		// the requested path resolves through the symlink, so we'd otherwise
		// reject every legitimate /tmp request on darwin agents.
		if rp, e := filepath.EvalSymlinks(ap); e == nil && rp != ap {
			if matchesPrefix(cleaned, rp) {
				return nil
			}
		}
	}
	return ErrPathNotAllowed
}

func matchesPrefix(target, prefix string) bool {
	return target == prefix || strings.HasPrefix(target, prefix+string(filepath.Separator))
}
