package auth

import (
	"context"
	"net/http"
	"strings"
)

const (
	cookieNameSecure = "__Host-shepherd_session"
	cookieNameDev    = "shepherd_session"
)

type ctxKey int

const ctxKeyAdmin ctxKey = 0

func AdminFromContext(ctx context.Context) (*Admin, bool) {
	a, ok := ctx.Value(ctxKeyAdmin).(*Admin)
	return a, ok
}

type Handler struct {
	Store  *Store
	Secure bool // set true when behind TLS reverse proxy
}

// CookieName is exported because the api package reads the cookie value on logout.
// `__Host-` cookies require Secure=true and no Domain attribute, which the browser
// won't honour over plain HTTP, so dev mode falls back to a non-prefixed name.
func (h *Handler) CookieName() string {
	if h.Secure {
		return cookieNameSecure
	}
	return cookieNameDev
}

// BearerToken returns the token from an "Authorization: Bearer <token>" header
// (scheme is case-insensitive), or "" if absent / a different scheme.
func BearerToken(r *http.Request) string {
	a := r.Header.Get("Authorization")
	const p = "Bearer "
	if len(a) <= len(p) || !strings.EqualFold(a[:len(p)], p) {
		return ""
	}
	return strings.TrimSpace(a[len(p):])
}

// sessionToken returns the caller's session token from the bearer header
// (preferred for non-browser clients) or the session cookie.
func (h *Handler) sessionToken(r *http.Request) string {
	if t := BearerToken(r); t != "" {
		return t
	}
	if c, err := r.Cookie(h.CookieName()); err == nil {
		return c.Value
	}
	return ""
}

func (h *Handler) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tok := h.sessionToken(r)
		if tok == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, admin, err := h.Store.LookupSession(r.Context(), tok)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), ctxKeyAdmin, admin)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (h *Handler) SetSessionCookie(w http.ResponseWriter, sess *Session) {
	http.SetCookie(w, &http.Cookie{
		Name:     h.CookieName(),
		Value:    sess.Token,
		Path:     "/",
		Expires:  sess.ExpiresAt,
		HttpOnly: true,
		Secure:   h.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}

func (h *Handler) ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     h.CookieName(),
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   h.Secure,
		SameSite: http.SameSiteLaxMode,
	})
}
