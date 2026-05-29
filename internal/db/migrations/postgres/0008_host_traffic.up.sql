CREATE TABLE host_traffic (
  server_id       BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cum_bytes_up    BIGINT  NOT NULL DEFAULT 0,
  cum_bytes_down  BIGINT  NOT NULL DEFAULT 0,
  prev_bytes_up   BIGINT  NOT NULL DEFAULT 0,
  prev_bytes_down BIGINT  NOT NULL DEFAULT 0,
  reset_day       INTEGER NOT NULL DEFAULT 1,
  last_reset_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL
);
INSERT INTO settings(key, value) VALUES ('traffic_reset_tz', 'UTC');
