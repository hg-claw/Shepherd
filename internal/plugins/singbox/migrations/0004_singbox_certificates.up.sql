CREATE TABLE IF NOT EXISTS singbox_certificates (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  domain                TEXT    NOT NULL UNIQUE,
  cert_pem              TEXT    NOT NULL,
  key_pem               TEXT    NOT NULL,
  expires_at            TIMESTAMP NOT NULL,
  issuer                TEXT    NOT NULL DEFAULT 'Let''s Encrypt',
  status                TEXT    NOT NULL DEFAULT 'issuing'
                                  CHECK (status IN ('issuing', 'active', 'failed', 'revoked')),
  last_renew_attempt_at TIMESTAMP,
  last_error            TEXT,
  created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
