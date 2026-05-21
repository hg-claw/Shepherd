CREATE TABLE xray_binaries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       TEXT    NOT NULL,
  os            TEXT    NOT NULL,
  arch          TEXT    NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  downloaded_at TIMESTAMP NOT NULL,
  UNIQUE(version, os, arch)
);
