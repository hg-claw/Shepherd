package auth

import (
	"context"
	"net/http"
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

func (h *Handler) RequireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(h.CookieName())
		if err != nil || c.Value == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		_, admin, err := h.Store.LookupSession(r.Context(), c.Value)
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
