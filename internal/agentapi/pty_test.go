package agentapi

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestPTYTypesRoundTrip(t *testing.T) {
	open := PTYOpen{Sid: "s", Kind: PTYKindConsole, User: "root", Rows: 24, Cols: 80, Term: "xterm-256color", TimeoutS: 0}
	env, err := Frame(TypePTYOpen, open)
	if err != nil {
		t.Fatal(err)
	}
	if env.Type != "pty.open" {
		t.Fatalf("type=%q", env.Type)
	}
	var got PTYOpen
	if err := json.Unmarshal(env.P, &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, open) {
		t.Fatalf("roundtrip mismatch: %+v vs %+v", got, open)
	}
}

func TestPTYExitJSON(t *testing.T) {
	exit := PTYExit{Sid: "s", Code: 0}
	b, _ := json.Marshal(exit)
	if string(b) != `{"sid":"s","code":0}` {
		t.Fatalf("json shape: %s", b)
	}
}
