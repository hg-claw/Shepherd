CREATE TABLE subgen_templates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  builtin    INTEGER NOT NULL DEFAULT 0,
  rules_json TEXT    NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subgen_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  token       TEXT    NOT NULL UNIQUE,
  template_id INTEGER NOT NULL REFERENCES subgen_templates(id) ON DELETE RESTRICT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subgen_subscription_inbounds (
  subscription_id INTEGER NOT NULL REFERENCES subgen_subscriptions(id) ON DELETE CASCADE,
  source          TEXT    NOT NULL,
  inbound_id      INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, source, inbound_id)
);
