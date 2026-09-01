package mieru

import (
	"context"
	"testing"
)

func TestMitaAssetName(t *testing.T) {
	if got := mitaAssetName("3.36.0", "amd64"); got != "mita_3.36.0_linux_amd64.tar.gz" {
		t.Fatalf("got %s", got)
	}
}

func TestResolveFetchSpecRejectsNonLinux(t *testing.T) {
	_, err := (&Releaser{}).ResolveFetchSpec(context.Background(), "3.36.0", "darwin", "arm64", false)
	if err == nil {
		t.Fatal("expected linux-only error")
	}
}
