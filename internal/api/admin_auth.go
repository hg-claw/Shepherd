package api

import (
	"net/http"

	"github.com/hg-claw/Shepherd/internal/auth"
)

type AuthAPI struct {
	Auth *auth.Handler
}

type loginReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func (a *AuthAPI) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad json")
		return
	}
	admin, err := a.Auth.Store.FindAdminByUsername(r.Context(), req.Username)
	if err != nil || !auth.VerifyPassword(admin.PasswordHash, req.Password) {
		writeError(w, http.StatusUnauthorized, "invalid credentials")
		return
	}
	sess, err := a.Auth.Store.IssueSession(r.Context(), admin.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "session error")
		return
	}
	a.Auth.SetSessionCookie(w, sess)
	writeJSON(w, http.StatusOK, map[string]any{
		"id":       admin.ID,
		"username": admin.Username,
	})
}

func (a *AuthAPI) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(a.Auth.CookieName()); err == nil && c.Value != "" {
		_ = a.Auth.Store.RevokeSession(r.Context(), c.Value)
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
