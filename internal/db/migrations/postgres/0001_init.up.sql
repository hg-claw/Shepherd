CREATE TABLE admins (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  admin_id    BIGINT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE servers (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  public_alias       TEXT,
  public_group       TEXT,
  country_code       TEXT,
  show_on_public     BOOLEAN NOT NULL DEFAULT FALSE,

  ssh_host           TEXT,
  ssh_port           INTEGER NOT NULL DEFAULT 22,
  ssh_user           TEXT,
  install_stage      TEXT NOT NULL DEFAULT 'pending',
  install_log        TEXT NOT NULL DEFAULT '',
  install_error      TEXT,
  install_started_at TIMESTAMPTZ,

  agent_version      TEXT,
  agent_os           TEXT,
  agent_arch         TEXT,
  agent_kernel       TEXT,
  agent_last_seen    TIMESTAMPTZ,
  agent_fingerprint  TEXT UNIQUE,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_servers_show_on_public ON servers(show_on_public);

CREATE TABLE enrollment_tokens (
  token       TEXT PRIMARY KEY,
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE machine_tokens (
  token       TEXT PRIMARY KEY,
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rotated_at  TIMESTAMPTZ
);

CREATE TABLE telemetry_samples_30s (
  server_id   BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  cpu_pct     DOUBLE PRECISION,
  mem_used    BIGINT,
  mem_total   BIGINT,
  load_1      DOUBLE PRECISION,
  load_5      DOUBLE PRECISION,
  load_15     DOUBLE PRECISION,
  net_rx_bps  BIGINT,
  net_tx_bps  BIGINT,
  tcp_conn    INTEGER,
  disks_json  TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_5m (
  server_id      BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL,
  cpu_avg        DOUBLE PRECISION, cpu_max DOUBLE PRECISION,
  mem_used_avg   BIGINT, mem_used_max BIGINT, mem_total BIGINT,
  load_1_avg     DOUBLE PRECISION, load_1_max DOUBLE PRECISION,
  net_rx_bps_avg BIGINT, net_rx_bps_max BIGINT,
  net_tx_bps_avg BIGINT, net_tx_bps_max BIGINT,
  tcp_conn_avg   INTEGER, tcp_conn_max INTEGER,
  disks_json     TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_1h (
  server_id      BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMPTZ NOT NULL,
  cpu_avg        DOUBLE PRECISION, cpu_max DOUBLE PRECISION,
  mem_used_avg   BIGINT, mem_used_max BIGINT, mem_total BIGINT,
  load_1_avg     DOUBLE PRECISION, load_1_max DOUBLE PRECISION,
  net_rx_bps_avg BIGINT, net_rx_bps_max BIGINT,
  net_tx_bps_avg BIGINT, net_tx_bps_max BIGINT,
  tcp_conn_avg   INTEGER, tcp_conn_max INTEGER,
  disks_json     TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings(key, value) VALUES
  ('public_display_mode', 'both'),
  ('retention_30s', '24h'),
  ('retention_5m', '7d'),
  ('retention_1h', '90d'),
  ('default_telemetry_interval_seconds', '30');
