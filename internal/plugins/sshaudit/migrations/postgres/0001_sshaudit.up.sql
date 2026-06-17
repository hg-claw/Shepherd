-- sshaudit plugin (postgres). Shape matches the sqlite migration; key
-- differences: BIGSERIAL for autoincrement, BOOLEAN where sqlite stores
-- 0/1 INTEGER, TIMESTAMPTZ for timezone-aware timestamps.

CREATE TABLE sshaudit_hosts (
  server_id             BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  enabled               BOOLEAN     NOT NULL DEFAULT FALSE,
  poll_interval_seconds INTEGER     NOT NULL DEFAULT 300,
  cursor_ts             TIMESTAMPTZ,
  last_collect_at       TIMESTAMPTZ,
  last_error            TEXT,
  updated_at            TIMESTAMPTZ NOT NULL
);

CREATE TABLE sshaudit_events (
  id           BIGSERIAL   PRIMARY KEY,
  server_id    BIGINT      NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ NOT NULL,
  result       TEXT        NOT NULL,
  method       TEXT        NOT NULL DEFAULT '',
  invalid_user BOOLEAN     NOT NULL DEFAULT FALSE,
  username     TEXT        NOT NULL DEFAULT '',
  source_ip    TEXT        NOT NULL DEFAULT '',
  port         INTEGER,
  created_at   TIMESTAMPTZ NOT NULL,
  UNIQUE(server_id, ts, result, username, source_ip, port)
);
CREATE INDEX sshaudit_events_server_ts ON sshaudit_events(server_id, ts);
