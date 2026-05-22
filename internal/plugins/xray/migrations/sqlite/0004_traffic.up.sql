-- raw 30s samples, retained 24h
CREATE TABLE IF NOT EXISTS xray_traffic_raw (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS xray_traffic_raw_srv_tag_ts
    ON xray_traffic_raw (server_id, tag, ts);
CREATE INDEX IF NOT EXISTS xray_traffic_raw_ts
    ON xray_traffic_raw (ts);

-- 1min aggregates, retained 7d
CREATE TABLE IF NOT EXISTS xray_traffic_minute (
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS xray_traffic_minute_ts
    ON xray_traffic_minute (ts);

-- 1h aggregates, retained 90d
CREATE TABLE IF NOT EXISTS xray_traffic_hour (
    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    tag         TEXT    NOT NULL,
    kind        TEXT    NOT NULL CHECK (kind IN ('inbound', 'outbound')),
    ts          DATETIME NOT NULL,
    bytes_up    INTEGER NOT NULL DEFAULT 0,
    bytes_down  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, tag, kind, ts)
);
CREATE INDEX IF NOT EXISTS xray_traffic_hour_ts
    ON xray_traffic_hour (ts);
