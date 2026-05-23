-- netquality plugin: per-server ping-based network quality probes.
--
-- Two-level shape mirrors what we use for singbox traffic: a small
-- catalog table (targets) joined against a per-server config table
-- (hosts), feeding tall sample tables that get rolled up to minute /
-- hour grain.

-- Builtin and admin-defined ping destinations. source='builtin' rows
-- ship via plugin migrations / seed; source='custom' rows are added
-- through the admin UI. Builtin rows may be disabled but not deleted —
-- we keep them around so historical samples still resolve a label.
CREATE TABLE netquality_targets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT    NOT NULL CHECK(source IN ('builtin','custom')),
  -- isp narrows the bucket the dashboards group by. 'overseas' covers
  -- any non-CN provider; per-country split lives in `region` for now.
  isp        TEXT    NOT NULL CHECK(isp IN ('telecom','unicom','mobile','overseas')),
  region     TEXT    NOT NULL,           -- "Shanghai", "Tokyo", etc.
  label      TEXT    NOT NULL,           -- display name (operator+region)
  host       TEXT    NOT NULL,           -- IP or hostname pinged
  enabled    INTEGER NOT NULL DEFAULT 1, -- 0/1; lets admin hide builtin rows
  created_at TIMESTAMP NOT NULL,
  UNIQUE(source, host)
);
CREATE INDEX netquality_targets_isp ON netquality_targets(isp, enabled);

-- Per-server enable + cadence. One row per managed server that has the
-- plugin turned on. sample_interval_seconds is operator-controllable so
-- bursty hosts can poll faster, quiet hosts can pull back.
CREATE TABLE netquality_hosts (
  server_id               INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  enabled                 INTEGER NOT NULL DEFAULT 0,
  sample_interval_seconds INTEGER NOT NULL DEFAULT 300, -- 5 min default
  last_error              TEXT,                          -- last sampler error (truncated)
  updated_at              TIMESTAMP NOT NULL
);

-- Raw samples landing straight off the agent. 24h retention then aged
-- into the minute table.
CREATE TABLE netquality_samples_raw (
  server_id   INTEGER   NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id   INTEGER   NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,
  rtt_avg_ms  REAL,                  -- nullable when status != 'ok'
  rtt_min_ms  REAL,
  rtt_max_ms  REAL,
  jitter_ms   REAL,                  -- stddev across the burst
  loss_pct    REAL    NOT NULL,      -- 0..100
  -- status='ok' on at least one reply; 'lost' on 100% loss; 'error' on
  -- ping invocation failure (e.g. no route, name resolution).
  status      TEXT    NOT NULL CHECK(status IN ('ok','lost','error')),
  PRIMARY KEY (server_id, target_id, ts)
);
CREATE INDEX netquality_samples_raw_ts ON netquality_samples_raw(ts);

-- Minute rollup: one row per (server, target, minute). 7d retention.
CREATE TABLE netquality_samples_minute (
  server_id   INTEGER   NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id   INTEGER   NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,
  rtt_avg_ms  REAL,
  loss_pct    REAL    NOT NULL,
  samples     INTEGER NOT NULL,      -- raw rows folded in (lets the UI flag thin minutes)
  PRIMARY KEY (server_id, target_id, ts)
);
CREATE INDEX netquality_samples_minute_ts ON netquality_samples_minute(ts);

-- Hour rollup: 90d retention.
CREATE TABLE netquality_samples_hour (
  server_id   INTEGER   NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id   INTEGER   NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  ts          TIMESTAMP NOT NULL,
  rtt_avg_ms  REAL,
  loss_pct    REAL    NOT NULL,
  samples     INTEGER NOT NULL,
  PRIMARY KEY (server_id, target_id, ts)
);
CREATE INDEX netquality_samples_hour_ts ON netquality_samples_hour(ts);
