package xray

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"

	"golang.org/x/crypto/curve25519"
)

// GenerateX25519 returns a fresh X25519 keypair encoded base64-URL (no padding),
// the same format xray's `xray x25519` CLI emits and what REALITY expects in
// privateKey / publicKey config fields.
func GenerateX25519() (privateKey, publicKey string, err error) {
	var priv [32]byte
	if _, err := rand.Read(priv[:]); err != nil {
		return "", "", err
	}
	// Per RFC 7748: clamp the private scalar.
	priv[0] &= 248
	priv[31] &= 127
	priv[31] |= 64
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return "", "", fmt.Errorf("x25519: %w", err)
	}
	enc := base64.RawURLEncoding
	return enc.EncodeToString(priv[:]), enc.EncodeToString(pub), nil
}

// GenerateShortID returns a hex-encoded short ID. REALITY accepts 0-16 hex chars.
// We default to 8 bytes (16 hex digits) which matches typical xray docs examples.
func GenerateShortID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
