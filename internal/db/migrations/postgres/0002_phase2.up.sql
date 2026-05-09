CREATE TABLE pty_sessions (
  id              BIGSERIAL PRIMARY KEY,
  server_id       BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  admin_id        BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  kind            TEXT    NOT NULL CHECK (kind IN ('console','script')),
  exec_user       TEXT    NOT NULL DEFAULT 'root',
  rows            INTEGER NOT NULL DEFAULT 24,
  cols            INTEGER NOT NULL DEFAULT 80,
  exec            TEXT    NOT NULL DEFAULT '',
  recording_path  TEXT,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  exit_code       INTEGER,
  ended_reason    TEXT
);
CREATE INDEX pty_sessions_server ON pty_sessions(server_id, started_at);
CREATE INDEX pty_sessions_admin  ON pty_sessions(admin_id, started_at);

CREATE TABLE scripts (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT    NOT NULL UNIQUE,
  description        TEXT    NOT NULL DEFAULT '',
  content            TEXT    NOT NULL,
  params_json        TEXT    NOT NULL DEFAULT '[]',
  default_timeout_s  INTEGER,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL
);

CREATE TABLE script_runs (
  id          BIGSERIAL PRIMARY KEY,
  script_id   BIGINT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  admin_id    BIGINT NOT NULL REFERENCES admins(id) ON DELETE RESTRICT,
  args_json   TEXT   NOT NULL DEFAULT '{}',
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);
CREATE INDEX script_runs_started ON script_runs(started_at);

CREATE TABLE script_run_targets (
  id              BIGSERIAL PRIMARY KEY,
  run_id          BIGINT NOT NULL REFERENCES script_runs(id) ON DELETE CASCADE,
  server_id       BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  pty_session_id  BIGINT REFERENCES pty_sessions(id) ON DELETE SET NULL,
  status          TEXT   NOT NULL,
  exit_code       INTEGER,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ
);
CREATE INDEX script_run_targets_run ON script_run_targets(run_id);

CREATE TABLE audit_log (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL,
  admin_id      BIGINT REFERENCES admins(id) ON DELETE SET NULL,
  server_id     BIGINT REFERENCES servers(id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  details_json  TEXT NOT NULL DEFAULT '{}',
  result        TEXT NOT NULL DEFAULT 'ok'
);
CREATE INDEX audit_log_ts        ON audit_log(ts);
CREATE INDEX audit_log_server_ts ON audit_log(server_id, ts);
CREATE INDEX audit_log_action_ts ON audit_log(action, ts);

INSERT INTO settings(key, value) VALUES
 ('file_sandbox_enabled',          'true'),
 ('file_sandbox_paths',             E'/tmp\n/var/log\n/etc/shepherd\n/home\n/Users\n/opt\n/srv'),
 ('audit_retention_days',           '30'),
 ('pty_recording_enabled',          'true'),
 ('pty_max_concurrent_per_admin',   '5'),
 ('file_upload_max_bytes',          '104857600'),
 ('file_chunk_bytes',               '262144')
ON CONFLICT(key) DO NOTHING;
