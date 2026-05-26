package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins/subgen"
)

type SubgenAPI struct {
	Service *subgen.Service
	limit   *tokenRateLimiter
}

func (a *SubgenAPI) InitRateLimit(max int, window time.Duration) {
	a.limit = newTokenRateLimiter(max, window)
}

// GetSubscription serves GET /sub/{token}?target=… — PUBLIC (token is the
// secret; no admin cookie). Wired on the root mux in router.go.
func (a *SubgenAPI) GetSubscription(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	if token == "" {
		http.NotFound(w, r)
		return
	}
	if a.limit != nil && !a.limit.allow(token) {
		writeError(w, 429, "rate limit exceeded")
		return
	}
	target := r.URL.Query().Get("target")
	body, ct, err := a.Service.Generate(r.Context(), token, target)
	switch {
	case errors.Is(err, subgen.ErrBadTarget):
		writeError(w, 400, "unknown target")
		return
	case errors.Is(err, subgen.ErrNotFound):
		http.NotFound(w, r)
		return
	case err != nil:
		writeError(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", ct)
	_, _ = w.Write([]byte(body))
}
