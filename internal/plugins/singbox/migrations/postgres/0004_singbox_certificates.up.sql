CREATE TABLE IF NOT EXISTS singbox_certificates (
  id                    BIGSERIAL PRIMARY KEY,
  domain                TEXT    NOT NULL UNIQUE,
  cert_pem              TEXT    NOT NULL,
  key_pem               TEXT    NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  issuer                TEXT    NOT NULL DEFAULT 'Let''s Encrypt',
  status                TEXT    NOT NULL DEFAULT 'issuing'
                                  CHECK (status IN ('issuing', 'active', 'failed', 'revoked')),
  last_renew_attempt_at TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Close the forward FK from 0001: cert_id was declared as a plain BIGINT
-- there because postgres can't reference a table that didn't yet exist.
-- Now that singbox_certificates is created we can add the constraint.
-- IF NOT EXISTS makes re-running idempotent (e.g. after a partial migrate).
ALTER TABLE singbox_inbounds
  ADD CONSTRAINT singbox_inbounds_cert_id_fkey
  FOREIGN KEY (cert_id) REFERENCES singbox_certificates(id) ON DELETE RESTRICT;
