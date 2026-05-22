-- SQLite does not support DROP COLUMN on tables with CHECK constraints portably;
-- recreate the table without challenge_type.
CREATE TABLE singbox_certificates_old AS SELECT
  id, domain, cert_pem, key_pem, expires_at, issuer, status,
  last_renew_attempt_at, last_error, created_at, updated_at
FROM singbox_certificates;

DROP TABLE singbox_certificates;

CREATE TABLE singbox_certificates (
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

INSERT INTO singbox_certificates SELECT * FROM singbox_certificates_old;
DROP TABLE singbox_certificates_old;
