CREATE TABLE admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,
  admin_id    INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at  TIMESTAMP NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE servers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  name               TEXT    NOT NULL,
  public_alias       TEXT,
  public_group       TEXT,
  country_code       TEXT,
  show_on_public     INTEGER NOT NULL DEFAULT 0,

  ssh_host           TEXT,
  ssh_port           INTEGER NOT NULL DEFAULT 22,
  ssh_user           TEXT,
  install_stage      TEXT    NOT NULL DEFAULT 'pending',
  install_log        TEXT    NOT NULL DEFAULT '',
  install_error      TEXT,
  install_started_at TIMESTAMP,

  agent_version      TEXT,
  agent_os           TEXT,
  agent_arch         TEXT,
  agent_kernel       TEXT,
  agent_last_seen    TIMESTAMP,
  agent_fingerprint  TEXT UNIQUE,

  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_servers_show_on_public ON servers(show_on_public);

CREATE TABLE enrollment_tokens (
  token       TEXT PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  expires_at  TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE machine_tokens (
  token       TEXT PRIMARY KEY,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  rotated_at  TIMESTAMP
);

CREATE TABLE telemetry_samples_30s (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,
  cpu_pct     REAL,
  mem_used    INTEGER,
  mem_total   INTEGER,
  load_1      REAL,
  load_5      REAL,
  load_15     REAL,
  net_rx_bps  INTEGER,
  net_tx_bps  INTEGER,
  tcp_conn    INTEGER,
  disks_json  TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_5m (
  server_id      INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMP NOT NULL,
  cpu_avg        REAL, cpu_max REAL,
  mem_used_avg   INTEGER, mem_used_max INTEGER, mem_total INTEGER,
  load_1_avg     REAL, load_1_max REAL,
  net_rx_bps_avg INTEGER, net_rx_bps_max INTEGER,
  net_tx_bps_avg INTEGER, net_tx_bps_max INTEGER,
  tcp_conn_avg   INTEGER, tcp_conn_max INTEGER,
  disks_json     TEXT,
  PRIMARY KEY (server_id, ts)
);

CREATE TABLE telemetry_rollup_1h (
  server_id      INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts             TIMESTAMP NOT NULL,
  cpu_avg        REAL, cpu_max REAL,
  mem_used_avg   INTEGER, mem_used_max INTEGER, mem_total INTEGER,
  load_1_avg     REAL, load_1_max REAL,
  net_rx_bps_avg INTEGER, net_rx_bps_max INTEGER,
  net_tx_bps_avg INTEGER, net_tx_bps_max INTEGER,
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
