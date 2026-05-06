package installer

import (
	"strings"
	"testing"
)

func TestGitHubDistribution_Snippet(t *testing.T) {
	d := GitHubDistribution{Owner: "hg-claw", Repo: "Shepherd", Tag: "v0.1.0"}
	_, snip, streamed, err := d.Provide("amd64")
	if err != nil {
		t.Fatal(err)
	}
	if streamed {
		t.Error("github mode should be snippet, not streamed")
	}
	if !strings.Contains(snip, "shepherd-agent-linux-amd64") || !strings.Contains(snip, "v0.1.0") {
		t.Errorf("snippet=%q", snip)
	}
}

func TestEmbeddedDistribution_MissingArch(t *testing.T) {
	if _, _, _, err := (EmbeddedDistribution{}).Provide("riscv"); err != ErrUnsupportedArch {
		t.Fatalf("err=%v", err)
	}
}
