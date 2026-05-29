CREATE TABLE host_traffic (
  server_id       INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cum_bytes_up    INTEGER NOT NULL DEFAULT 0,
  cum_bytes_down  INTEGER NOT NULL DEFAULT 0,
  prev_bytes_up   INTEGER NOT NULL DEFAULT 0,
  prev_bytes_down INTEGER NOT NULL DEFAULT 0,
  reset_day       INTEGER NOT NULL DEFAULT 1,
  last_reset_at   TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL
);
INSERT INTO settings(key, value) VALUES ('traffic_reset_tz', 'UTC');
