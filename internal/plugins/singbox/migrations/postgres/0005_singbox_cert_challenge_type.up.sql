-- Add challenge_type to singbox_certificates so the renewal loop can re-issue
-- using the same ACME challenge mechanism that was used at issuance time.
ALTER TABLE singbox_certificates
  ADD COLUMN challenge_type TEXT NOT NULL DEFAULT 'http-01'
    CHECK (challenge_type IN ('dns-01-cf', 'http-01'));
