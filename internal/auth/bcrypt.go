package auth

import "golang.org/x/crypto/bcrypt"

const bcryptCost = 12

// DummyHash is a valid bcrypt hash (cost 12) of an arbitrary fixed string. It is
// used only to spend constant bcrypt time on the login username-not-found path so
// response latency cannot distinguish a missing user from a wrong password.
const DummyHash = "$2a$12$AHF.apOKYbCydULJSlOhA.kpg4BSLCHiTJEF9Vjhs0WR3e1Aled5q"

func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcryptCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func VerifyPassword(hash, plain string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(plain)) == nil
}
