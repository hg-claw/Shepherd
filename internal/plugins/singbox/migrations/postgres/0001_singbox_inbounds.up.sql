CREATE TABLE IF NOT EXISTS singbox_inbounds (
  id                        BIGSERIAL PRIMARY KEY,
  server_id                 BIGINT  NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag                       TEXT    NOT NULL,
  port                      INTEGER NOT NULL,
  role                      TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  protocol                  TEXT    NOT NULL,

  -- VLESS / VMess shared
  uuid                      TEXT,
  flow                      TEXT,

  -- Trojan / SS-2022 / Hysteria2 / TUIC
  password                  TEXT,

  -- TLS (VLESS+TLS / Trojan / Hysteria2 / TUIC / AnyTLS)
  sni                       TEXT,
  cert_id                   BIGINT REFERENCES singbox_certificates(id) ON DELETE RESTRICT,

  -- REALITY (VLESS-REALITY)
  reality_private_key       TEXT,
  reality_public_key        TEXT,
  reality_short_id          TEXT,
  reality_handshake_server  TEXT,
  reality_handshake_port    INTEGER,

  -- Transport (WS / H2 / HTTPUpgrade)
  transport_path            TEXT,
  transport_host            TEXT,

  -- VMess
  alter_id                  INTEGER DEFAULT 0,

  -- Shadowsocks-2022
  ss_method                 TEXT,

  -- Relay topology
  upstream_inbound_id       BIGINT REFERENCES singbox_inbounds(id) ON DELETE RESTRICT,

  -- Protocol-specific extensions (Hysteria2 up_mbps/down_mbps; TUIC congestion_control; etc.)
  extra_json                TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay'   AND upstream_inbound_id IS NOT NULL)
  ),
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);

CREATE INDEX IF NOT EXISTS singbox_inbounds_server
    ON singbox_inbounds(server_id);
CREATE INDEX IF NOT EXISTS singbox_inbounds_upstream
    ON singbox_inbounds(upstream_inbound_id);
CREATE INDEX IF NOT EXISTS singbox_inbounds_cert
    ON singbox_inbounds(cert_id);
