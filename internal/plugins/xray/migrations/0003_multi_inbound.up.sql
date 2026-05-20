CREATE TABLE IF NOT EXISTS xray_inbounds (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id            INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag                  TEXT    NOT NULL,
  port                 INTEGER NOT NULL,
  role                 TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol             TEXT    NOT NULL DEFAULT 'vless-reality',
  uuid                 TEXT,
  sni                  TEXT,
  public_key           TEXT,
  private_key          TEXT,
  short_id             TEXT,
  ws_path              TEXT,
  ss_method            TEXT,
  ss_password          TEXT,
  upstream_inbound_id  INTEGER REFERENCES xray_inbounds(id) ON DELETE RESTRICT,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay'   AND upstream_inbound_id IS NOT NULL)
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

CREATE INDEX IF NOT EXISTS xray_inbounds_server   ON xray_inbounds(server_id);
CREATE INDEX IF NOT EXISTS xray_inbounds_upstream ON xray_inbounds(upstream_inbound_id);

-- xray_host_topology is replaced by xray_inbounds.upstream_inbound_id.
-- It is intentionally NOT dropped here; v0.4.0 will drop it via 0004_cleanup.up.sql
-- to give two release windows for any external code that still reads it.
