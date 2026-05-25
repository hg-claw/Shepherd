package vlog

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestSetEnabledReturnsPrior(t *testing.T) {
	SetEnabled(false) // reset
	if prev := SetEnabled(true); prev != false {
		t.Fatalf("first SetEnabled(true) prev = %v, want false", prev)
	}
	if prev := SetEnabled(false); prev != true {
		t.Fatalf("SetEnabled(false) after on, prev = %v, want true", prev)
	}
}

func TestDebugfOnlyWhenEnabled(t *testing.T) {
	var buf bytes.Buffer
	oldOut := log.Writer()
	oldFlags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(oldOut)
		log.SetFlags(oldFlags)
		SetEnabled(false)
	})

	SetEnabled(false)
	Debugf("hidden %d", 1)
	if buf.Len() != 0 {
		t.Fatalf("Debugf printed while disabled: %q", buf.String())
	}

	SetEnabled(true)
	Debugf("visible %d", 2)
	if got := buf.String(); !strings.Contains(got, "DBG visible 2") {
		t.Fatalf("Debugf missing DBG prefix or formatted line: %q", got)
	}
}
