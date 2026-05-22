CREATE TABLE IF NOT EXISTS singbox_binaries (
  version        TEXT    NOT NULL,
  os             TEXT    NOT NULL,
  arch           TEXT    NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT    NOT NULL,
  downloaded_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (version, os, arch)
);
