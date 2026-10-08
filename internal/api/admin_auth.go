package api

import (
	"net"
	"net/http"
	"time"

	"github.com/hg-claw/Shepherd/internal/auth"
)

type AuthAPI struct {
	Auth  *auth.Handler
	limit *tokenRateLimiter // nil → no limiting (e.g. tests that don't init)
}

// InitRateLimit configures per-IP + per-username login throttling. Mirrors
// PublicAPI/SubgenAPI; called from main.go.
func (a *AuthAPI) InitRateLimit(max int, window time.Duration) {
	a.limit = newTokenRateLimiter(max, window)
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Client   string `json:"client,omitempty"` // "mobile" → also return the token in the body
}

func (a *AuthAPI) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	ip := clientIP(r)
	userKey := "user:" + req.Username
	// Peek before any work; do NOT record here, so an attacker cannot extend the
	// lockout window indefinitely — it self-clears `window` after the last failure.
	if a.limit != nil && (a.limit.blocked(ip) || a.limit.blocked(userKey)) {
		writeError(w, http.StatusTooManyRequests, "too many attempts")
		return
	}

	admin, err := a.Auth.Store.FindAdminByUsername(r.Context(), req.Username)
	ok := false
	if err != nil {
		// Constant-time: spend a bcrypt comparison even when the user is unknown,
		// so latency cannot reveal whether the username exists.
		_ = auth.VerifyPassword(auth.DummyHash, req.Password)
	} else {
		ok = auth.VerifyPassword(admin.PasswordHash, req.Password)
	}
	if !ok {
		if a.limit != nil {
			a.limit.record(ip)
			a.limit.record(userKey)
		}
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	sess, err := a.Auth.Store.IssueSession(r.Context(), admin.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session error")
		return
	}
	if a.limit != nil {
		a.limit.reset(ip)
		a.limit.reset(userKey)
	}
	a.Auth.SetSessionCookie(w, sess)
	out := map[string]any{"id": admin.ID, "username": admin.Username}
	if req.Client == "mobile" || r.URL.Query().Get("token") == "1" {
		out["token"] = sess.Token
	}
	writeJSON(w, http.StatusOK, out)
}

type changePasswordReq struct {
	CurrentPassword string `json:"current_password"`
	NewPassword     string `json:"new_password"`
}

// ChangePassword lets the logged-in admin rotate their own password. The
// current password is required as proof of possession (a stolen session
// cookie alone must not suffice). On success every OTHER session for this
// admin is revoked — the caller's session survives so the browser isn't
// abruptly logged out.
func (a *AuthAPI) ChangePassword(w http.ResponseWriter, r *http.Request) {
	var req changePasswordReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	admin, ok := auth.AdminFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if !auth.VerifyPassword(admin.PasswordHash, req.CurrentPassword) {
		writeError(w, http.StatusBadRequest, "current password is incorrect")
		return
	}
	if len(req.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "new password must be at least 8 characters")
		return
	}
	if req.NewPassword == req.CurrentPassword {
		writeError(w, http.StatusBadRequest, "new password must differ from the current one")
		return
	}
	if err := a.Auth.Store.UpdatePassword(r.Context(), admin.ID, req.NewPassword); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	tok := auth.BearerToken(r)
	if tok == "" {
		if c, err := r.Cookie(a.Auth.CookieName()); err == nil {
			tok = c.Value
		}
	}
	if err := a.Auth.Store.RevokeOtherSessions(r.Context(), admin.ID, tok); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (a *AuthAPI) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(a.Auth.CookieName()); err == nil && c.Value != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), c.Value)
	} else if tok := auth.BearerToken(r); tok != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), tok)
	}
	a.Auth.ClearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (a *AuthAPI) Me(w http.ResponseWriter, r *http.Request) {
	admin, ok := auth.AdminFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       admin.ID,
		"username": admin.Username,
	})
}

// clientIP returns the host part of the direct TCP peer (RemoteAddr). NOTE: it
// does NOT honor X-Forwarded-For — doing so safely requires a trusted-proxy
// allowlist and is a deliberate follow-up.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
