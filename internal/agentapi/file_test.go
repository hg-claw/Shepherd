package agentapi

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestFileUploadAckRoundTrip(t *testing.T) {
	in := FileUploadAck{Sid: "s1", OK: false, Error: "sha mismatch"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `{"sid":"s1","ok":false,"error":"sha mismatch"}` {
		t.Fatalf("json shape: %s", b)
	}
	var out FileUploadAck
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out, in) {
		t.Fatalf("roundtrip mismatch: %+v", out)
	}
}

func TestFileStatResultErrorShape(t *testing.T) {
	in := FileStatResult{Sid: "s2", Error: "no such file"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	// Entry must be omitted when nil/zero.
	if string(b) != `{"sid":"s2","error":"no such file"}` {
		t.Fatalf("json shape: %s", b)
	}
}

func TestFileListResultEmptyEntries(t *testing.T) {
	in := FileListResult{Sid: "s3"}
	b, _ := json.Marshal(in)
	if string(b) != `{"sid":"s3"}` {
		t.Fatalf("json shape: %s", b)
	}
}
