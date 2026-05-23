-- Postgres mirror of 0002_host_targets.

CREATE TABLE netquality_host_targets (
  server_id BIGINT  NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id BIGINT  NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (server_id, target_id)
);
CREATE INDEX netquality_host_targets_target ON netquality_host_targets(target_id);
