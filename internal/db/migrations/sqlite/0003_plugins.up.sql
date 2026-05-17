CREATE TABLE plugins (
  id          TEXT      PRIMARY KEY,
  enabled     INTEGER   NOT NULL DEFAULT 0,
  config_json TEXT      NOT NULL DEFAULT '{}',
  enabled_at  TIMESTAMP,
  created_at  TIMESTAMP NOT NULL
);

CREATE TABLE plugin_hosts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id        TEXT    NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  config_json      TEXT    NOT NULL DEFAULT '{}',
  deployed_version TEXT,
  status           TEXT    NOT NULL DEFAULT 'pending',
  last_error       TEXT,
  updated_at       TIMESTAMP NOT NULL,
  UNIQUE(plugin_id, server_id)
);
CREATE INDEX plugin_hosts_plugin ON plugin_hosts(plugin_id);

CREATE TABLE plugin_migrations (
  plugin_id  TEXT      NOT NULL,
  name       TEXT      NOT NULL,
  applied_at TIMESTAMP NOT NULL,
  PRIMARY KEY (plugin_id, name)
);
