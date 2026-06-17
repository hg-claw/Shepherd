-- sshaudit plugin: per-server SSH login auditing.
--
-- Two tables: a per-server config/cursor table (hosts) and an append-only
-- event log (events) holding parsed sshd "Accepted"/"Failed"/"Invalid user"
-- lines. Collection runs server-side over the agent PTY-script channel
-- (no agent release needed); the cursor lets re-collection stay idempotent.

-- Per-server enable + poll cadence + collection cursor. One row per managed
-- server that has the plugin turned on (presence != enabled; the row also
-- holds the cursor/last-error even while disabled).
CREATE TABLE sshaudit_hosts (
  server_id            INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  enabled              INTEGER   NOT NULL DEFAULT 0,
  poll_interval_seconds INTEGER  NOT NULL DEFAULT 300,
  cursor_ts            TIMESTAMP,            -- max event ts collected so far
  last_collect_at      TIMESTAMP,            -- when collectHost last ran
  last_error           TEXT,                 -- last collect error (truncated)
  updated_at           TIMESTAMP NOT NULL
);

-- Parsed sshd auth events. result is 'accepted' or 'failed'; method is
-- 'password' | 'publickey' | '' (empty for bare "Invalid user" lines).
-- The UNIQUE constraint dedupes re-collection AND the double-counting
-- between an "Invalid user" line and its "Failed password for invalid user"
-- companion (same ts/user/ip/port). port is nullable because some lines
-- (bare "Invalid user") carry no port.
CREATE TABLE sshaudit_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER   NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  ts           TIMESTAMP NOT NULL,
  result       TEXT      NOT NULL,           -- 'accepted' | 'failed'
  method       TEXT      NOT NULL DEFAULT '',-- 'password' | 'publickey' | ''
  invalid_user INTEGER   NOT NULL DEFAULT 0,
  username     TEXT      NOT NULL DEFAULT '',
  source_ip    TEXT      NOT NULL DEFAULT '',
  port         INTEGER,
  created_at   TIMESTAMP NOT NULL,
  UNIQUE(server_id, ts, result, username, source_ip, port)
);
CREATE INDEX sshaudit_events_server_ts ON sshaudit_events(server_id, ts);
