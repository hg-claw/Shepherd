package plugins

import (
	"context"
	"testing"
)

// hubExecStub mirrors the production HostExec shape so tests can be sure
// the production adapter's signature matches.
type hubExecStub struct{}

func (hubExecStub) PushFile(context.Context, int64, string, uint32, []byte) error { return nil }
func (hubExecStub) RunCmd(context.Context, int64, string, ...string) ([]byte, []byte, int, error) {
	return nil, nil, 0, nil
}
func (hubExecStub) StreamCmd(context.Context, int64, string, []string, func(string)) error {
	return nil
}

func TestHubAdapterSatisfiesHostExec(t *testing.T) {
	var _ HostExec = (*hubExecStub)(nil)
}
