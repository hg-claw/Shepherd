package singbox

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hg-claw/Shepherd/internal/plugins"
)

// issueFunc and renewFunc are package-level vars that tests override.
// Production path is a no-op until Task 20 wires the real CF token provider.
var issueFunc = func(_ context.Context, _ int64, _, _, _ string) error {
	return nil
}

var renewFunc = func(_ context.Context, _ int64, _, _, _ string) error {
	return nil
}

// SetCertFuncs overrides issueFunc and renewFunc with production implementations.
// Called from main.go once certmgr.Manager is configured.
func SetCertFuncs(
	issue func(ctx context.Context, certID int64, domain, challengeType, email string) error,
	renew func(ctx context.Context, certID int64, domain, challengeType, email string) error,
) {
	issueFunc = issue
	renewFunc = renew
}

// validChallengeType checks that the challenge string is one of the allowed values.
func validChallengeType(s string) bool {
	return s == "dns-01-cf" || s == "http-01"
}

type postCertBody struct {
	Domain        string `json:"domain"`
	ChallengeType string `json:"challenge_type"`
	Email         string `json:"email"`
}

// certResponse is the safe (PEM-redacted) projection returned by GET /certificates.
type certResponse struct {
	ID                 int64   `json:"id"`
	Domain             string  `json:"domain"`
	Status             string  `json:"status"`
	Issuer             string  `json:"issuer"`
	ExpiresAt          string  `json:"expires_at"`
	ChallengeType      string  `json:"challenge_type"`
	LastRenewAttemptAt *string `json:"last_renew_attempt_at"`
	LastError          *string `json:"last_error"`
}

// postCertHandler handles POST /certificates.
// Body: {domain, challenge_type, email}.
// Creates row with status='issuing', kicks off async issueFunc. Returns 202 + {id}.
func postCertHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body postCertBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, 400, "bad json")
			return
		}
		if body.Domain == "" {
			writeErr(w, 400, "domain required")
			return
		}
		if !validChallengeType(body.ChallengeType) {
			writeErr(w, 400, "challenge_type must be 'dns-01-cf' or 'http-01'")
			return
		}
		if body.Email == "" {
			writeErr(w, 400, "email required")
			return
		}

		cs := &CertStore{DB: deps.DB}
		certID, err := cs.Insert(r.Context(), CertRow{
			Domain:        body.Domain,
			CertPEM:       "",
			KeyPEM:        "",
			ExpiresAt:     time.Time{},
			Status:        "issuing",
			ChallengeType: body.ChallengeType,
		})
		if err != nil {
			if isSQLiteConflict(err) {
				writeErr(w, 409, "domain already exists")
				return
			}
			writeErr(w, 500, err.Error())
			return
		}

		// Async ACME issuance.
		go func() {
			_ = issueFunc(context.Background(), certID, body.Domain, body.ChallengeType, body.Email)
		}()

		writeJSON(w, 202, map[string]any{"id": certID})
	}
}

// getCertsHandler handles GET /certificates.
// Returns all certs as JSON array; PEMs are redacted.
func getCertsHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cs := &CertStore{DB: deps.DB}
		rows, err := cs.List(r.Context())
		if err != nil {
			writeErr(w, 500, err.Error())
			return
		}
		out := make([]certResponse, 0, len(rows))
		for _, row := range rows {
			cr := certResponse{
				ID:            row.ID,
				Domain:        row.Domain,
				Status:        row.Status,
				Issuer:        row.Issuer,
				ExpiresAt:     row.ExpiresAt.UTC().Format(time.RFC3339),
				ChallengeType: row.ChallengeType,
				LastError:     row.LastError,
			}
			if row.LastRenewAttemptAt != nil {
				s := row.LastRenewAttemptAt.UTC().Format(time.RFC3339)
				cr.LastRenewAttemptAt = &s
			}
			out = append(out, cr)
		}
		writeJSON(w, 200, out)
	}
}

// deleteCertHandler handles DELETE /certificates/{id}.
// Returns 409 if the cert is in use by an inbound (FK RESTRICT).
func deleteCertHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 {
			writeErr(w, 400, "id required")
			return
		}
		cs := &CertStore{DB: deps.DB}
		if err := cs.Delete(r.Context(), id); err != nil {
			if isSQLiteFK(err) {
				writeErr(w, 409, "certificate is referenced by one or more inbounds")
				return
			}
			writeErr(w, 500, err.Error())
			return
		}
		w.WriteHeader(204)
	}
}

// postCertRenewHandler handles POST /certificates/{id}/renew.
// Kicks off async renewal via renewFunc. Returns 202.
func postCertRenewHandler(deps plugins.Deps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if id == 0 {
			writeErr(w, 400, "id required")
			return
		}
		cs := &CertStore{DB: deps.DB}
		row, err := cs.Get(r.Context(), id)
		if err != nil {
			writeErr(w, 404, "certificate not found")
			return
		}
		go func() {
			_ = renewFunc(context.Background(), row.ID, row.Domain, row.ChallengeType, "")
		}()
		writeJSON(w, 202, map[string]any{"ok": true})
	}
}

// isSQLiteConflict detects UNIQUE constraint violations from SQLite.
func isSQLiteConflict(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// isSQLiteFK detects FK constraint violations from SQLite.
func isSQLiteFK(err error) bool {
	return err != nil && strings.Contains(err.Error(), "FOREIGN KEY constraint failed")
}
