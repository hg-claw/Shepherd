PRAGMA foreign_keys=OFF;

ALTER TABLE singbox_inbounds RENAME TO singbox_inbounds_old;

CREATE TABLE singbox_inbounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  alias TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol TEXT NOT NULL,
  uuid TEXT,
  flow TEXT,
  password TEXT,
  sni TEXT,
  cert_id INTEGER REFERENCES singbox_certificates(id) ON DELETE RESTRICT,
  reality_private_key TEXT,
  reality_public_key TEXT,
  reality_short_id TEXT,
  reality_handshake_server TEXT,
  reality_handshake_port INTEGER,
  transport_path TEXT,
  transport_host TEXT,
  alter_id INTEGER DEFAULT 0,
  ss_method TEXT,
  upstream_inbound_id INTEGER REFERENCES singbox_inbounds(id) ON DELETE RESTRICT,
  custom_upstream_url TEXT NOT NULL DEFAULT '',
  relay_mode TEXT NOT NULL DEFAULT 'proxy',
  extra_json TEXT,
  ssh_forward_enabled INTEGER NOT NULL DEFAULT 0,
  ssh_host TEXT NOT NULL DEFAULT '',
  ssh_port INTEGER NOT NULL DEFAULT 22,
  ssh_username TEXT NOT NULL DEFAULT '',
  ssh_private_key TEXT NOT NULL DEFAULT '',
  ssh_use_localhost INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL AND custom_upstream_url = '') OR
    (role = 'relay' AND (
      (upstream_inbound_id IS NOT NULL AND custom_upstream_url = '') OR
      (upstream_inbound_id IS NULL AND custom_upstream_url <> '')
    ))
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

INSERT INTO singbox_inbounds (
  id, server_id, tag, alias, port, role, protocol, uuid, flow, password, sni, cert_id,
  reality_private_key, reality_public_key, reality_short_id, reality_handshake_server,
  reality_handshake_port, transport_path, transport_host, alter_id, ss_method,
  upstream_inbound_id, custom_upstream_url, relay_mode, extra_json, ssh_forward_enabled,
  ssh_host, ssh_port, ssh_username, ssh_private_key, ssh_use_localhost, created_at, updated_at
)
SELECT id, server_id, tag, COALESCE(alias, ''), port, role, protocol, uuid, flow, password, sni, cert_id,
  reality_private_key, reality_public_key, reality_short_id, reality_handshake_server,
  reality_handshake_port, transport_path, transport_host, alter_id, ss_method,
  upstream_inbound_id, '', COALESCE(relay_mode, 'proxy'), extra_json, ssh_forward_enabled,
  ssh_host, ssh_port, ssh_username, ssh_private_key, ssh_use_localhost, created_at, updated_at
FROM singbox_inbounds_old;

DROP TABLE singbox_inbounds_old;
CREATE INDEX IF NOT EXISTS singbox_inbounds_server ON singbox_inbounds(server_id);
CREATE INDEX IF NOT EXISTS singbox_inbounds_upstream ON singbox_inbounds(upstream_inbound_id);
CREATE INDEX IF NOT EXISTS singbox_inbounds_cert ON singbox_inbounds(cert_id);
PRAGMA foreign_keys=ON;
