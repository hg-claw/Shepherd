CREATE TABLE IF NOT EXISTS mieru_inbounds (
  id              BIGSERIAL PRIMARY KEY,
  server_id       BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag             TEXT    NOT NULL,
  alias           TEXT    NOT NULL DEFAULT '',
  port            INTEGER NOT NULL,
  protocol        TEXT    NOT NULL DEFAULT 'TCP'
                    CHECK (protocol IN ('TCP', 'UDP', 'BOTH')),
  username        TEXT    NOT NULL,
  password        TEXT    NOT NULL,
  mtu             INTEGER NOT NULL DEFAULT 1400,
  multiplexing    TEXT    NOT NULL DEFAULT 'MULTIPLEXING_OFF',
  handshake_mode  TEXT    NOT NULL DEFAULT 'HANDSHAKE_NO_WAIT',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (server_id, tag),
  UNIQUE (server_id, port)
);
CREATE INDEX IF NOT EXISTS mieru_inbounds_server ON mieru_inbounds(server_id);
