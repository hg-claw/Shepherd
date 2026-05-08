package agentapi

import (
	"crypto/rand"
	"encoding/base64"
	"regexp"
)

var sidPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

func NewSID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

func ValidSID(s string) bool {
	return sidPattern.MatchString(s)
}
