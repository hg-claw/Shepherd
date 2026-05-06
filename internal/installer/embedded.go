package installer

import (
	"bytes"
	"embed"
	"fmt"
	"io"
)

//go:embed bin/*
var agentBin embed.FS

// EmbeddedDistribution streams agent binaries packed at server build time.
// Plan 1.C wires the Makefile to populate internal/installer/bin/shepherd-agent-linux-<arch>
// as part of the server build. During Phase 1.A development, place placeholder bytes
// (e.g. compiled local agent) into bin/ before running install end-to-end.
type EmbeddedDistribution struct{}

func (EmbeddedDistribution) Provide(arch string) (io.Reader, string, bool, error) {
	if !validArch(arch) {
		return nil, "", false, ErrUnsupportedArch
	}
	name := fmt.Sprintf("bin/shepherd-agent-linux-%s", arch)
	b, err := agentBin.ReadFile(name)
	if err != nil {
		return nil, "", false, fmt.Errorf("agent binary missing for %s: build it before installing", arch)
	}
	return bytes.NewReader(b), "", true, nil
}
