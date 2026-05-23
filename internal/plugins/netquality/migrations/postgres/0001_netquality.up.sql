-- netquality plugin (postgres). Shape matches the sqlite migration; key
-- differences: BIGSERIAL for autoincrement, BOOLEAN where sqlite stores
-- 0/1 INTEGER, TIMESTAMPTZ for timezone-aware timestamps, DOUBLE PRECISION
-- in place of REAL.

CREATE TABLE netquality_targets (
  id         BIGSERIAL PRIMARY KEY,
  source     TEXT      NOT NULL CHECK(source IN ('builtin','custom')),
  isp        TEXT      NOT NULL CHECK(isp IN ('telecom','unicom','mobile','overseas')),
  region     TEXT      NOT NULL,
  label      TEXT      NOT NULL,
  host       TEXT      NOT NULL,
  enabled    BOOLEAN   NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(source, host)
);
CREATE INDEX netquality_targets_isp ON netquality_targets(isp, enabled);

CREATE TABLE netquality_hosts (
  server_id               BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  enabled                 BOOLEAN NOT NULL DEFAULT FALSE,
  sample_interval_seconds INTEGER NOT NULL DEFAULT 300,
  last_error              TEXT,
  updated_at              TIMESTAMPTZ NOT NULL
);

CREATE TABLE netquality_samples_raw (
  server_id   BIGINT      NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id   BIGINT      NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  rtt_avg_ms  DOUBLE PRECISION,
  rtt_min_ms  DOUBLE PRECISION,
  rtt_max_ms  DOUBLE PRECISION,
  jitter_ms   DOUBLE PRECISION,
  loss_pct    DOUBLE PRECISION NOT NULL,
  status      TEXT        NOT NULL CHECK(status IN ('ok','lost','error')),
  PRIMARY KEY (server_id, target_id, ts)
);
CREATE INDEX netquality_samples_raw_ts ON netquality_samples_raw(ts);

CREATE TABLE netquality_samples_minute (
  server_id   BIGINT      NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id   BIGINT      NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  rtt_avg_ms  DOUBLE PRECISION,
  loss_pct    DOUBLE PRECISION NOT NULL,
  samples     INTEGER     NOT NULL,
  PRIMARY KEY (server_id, target_id, ts)
);
CREATE INDEX netquality_samples_minute_ts ON netquality_samples_minute(ts);

CREATE TABLE netquality_samples_hour (
  server_id   BIGINT      NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id   BIGINT      NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  rtt_avg_ms  DOUBLE PRECISION,
  loss_pct    DOUBLE PRECISION NOT NULL,
  samples     INTEGER     NOT NULL,
  PRIMARY KEY (server_id, target_id, ts)
);
CREATE INDEX netquality_samples_hour_ts ON netquality_samples_hour(ts);
