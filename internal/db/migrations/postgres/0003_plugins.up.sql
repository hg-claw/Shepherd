CREATE TABLE plugins (
  id          TEXT        PRIMARY KEY,
  enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  config_json TEXT        NOT NULL DEFAULT '{}',
  enabled_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE plugin_hosts (
  id               BIGSERIAL    PRIMARY KEY,
  plugin_id        TEXT         NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  server_id        BIGINT       NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  config_json      TEXT         NOT NULL DEFAULT '{}',
  deployed_version TEXT,
  status           TEXT         NOT NULL DEFAULT 'pending',
  last_error       TEXT,
  updated_at       TIMESTAMPTZ  NOT NULL,
  UNIQUE(plugin_id, server_id)
);
CREATE INDEX plugin_hosts_plugin ON plugin_hosts(plugin_id);

CREATE TABLE plugin_migrations (
  plugin_id  TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
