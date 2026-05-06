package installer

import (
	"errors"
	"fmt"
	"io"
)

// Distribution provides the agent binary for a given target arch in one of two ways:
// stream the embedded bytes, or print a curl-from-GitHub script.
type Distribution interface {
	// Provide returns either an io.Reader to stream into /usr/local/bin/shepherd-agent (when streamed=true),
	// or a shell snippet to run on the target (when streamed=false). Caller chooses the path.
	Provide(arch string) (data io.Reader, snippet string, streamed bool, err error)
}

var ErrUnsupportedArch = errors.New("unsupported arch")

func validArch(a string) bool {
	return a == "amd64" || a == "arm64"
}

type GitHubDistribution struct {
	Owner string
	Repo  string
	Tag   string
}

func (g GitHubDistribution) Provide(arch string) (io.Reader, string, bool, error) {
	if !validArch(arch) {
		return nil, "", false, ErrUnsupportedArch
	}
	url := fmt.Sprintf("https://github.com/%s/%s/releases/download/%s/shepherd-agent-linux-%s",
		g.Owner, g.Repo, g.Tag, arch)
	snippet := fmt.Sprintf(`curl -fsSL %q -o /usr/local/bin/shepherd-agent && chmod +x /usr/local/bin/shepherd-agent`, url)
	return nil, snippet, false, nil
}
