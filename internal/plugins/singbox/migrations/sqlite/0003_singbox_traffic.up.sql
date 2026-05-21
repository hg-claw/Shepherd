-- raw 30s samples, retained 7 days
CREATE TABLE IF NOT EXISTS singbox_traffic_raw (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL CHECK (kind IN ('landing', 'relay')),
  ts          TIMESTAMP NOT NULL,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS singbox_traffic_raw_server_tag_ts
    ON singbox_traffic_raw(server_id, tag, ts);
CREATE INDEX IF NOT EXISTS singbox_traffic_raw_ts
    ON singbox_traffic_raw(ts);

-- 1min aggregates, retained 30 days
CREATE TABLE IF NOT EXISTS singbox_traffic_minute (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  ts          TIMESTAMP NOT NULL,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS singbox_traffic_minute_ts
    ON singbox_traffic_minute(ts);

-- 1h aggregates, retained 365 days
CREATE TABLE IF NOT EXISTS singbox_traffic_hour (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  tag         TEXT    NOT NULL,
  kind        TEXT    NOT NULL,
  ts          TIMESTAMP NOT NULL,
  bytes_up    INTEGER NOT NULL DEFAULT 0,
  bytes_down  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS singbox_traffic_hour_ts
    ON singbox_traffic_hour(ts);
