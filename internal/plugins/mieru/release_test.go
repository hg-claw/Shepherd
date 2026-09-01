package mieru

import (
	"context"
	"strings"
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

func TestUnitLinuxSkipsUDSPermissionEnforcement(t *testing.T) {
	s := string(unitLinux)
	if !strings.Contains(s, "MITA_INSECURE_UDS=") {
		t.Fatalf("unit must set MITA_INSECURE_UDS so mita does not require a system user named mita:\n%s", s)
	}
}


