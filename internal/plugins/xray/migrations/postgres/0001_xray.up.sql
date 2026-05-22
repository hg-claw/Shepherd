CREATE TABLE xray_binaries (
  id            BIGSERIAL PRIMARY KEY,
  version       TEXT    NOT NULL,
  os            TEXT    NOT NULL,
  arch          TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  downloaded_at TIMESTAMPTZ NOT NULL,
  UNIQUE(version, os, arch)
);
