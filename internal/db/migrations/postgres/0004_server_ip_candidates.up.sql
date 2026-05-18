CREATE TABLE server_ip_candidates (
  server_id   BIGINT      NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  addr        TEXT        NOT NULL,
  kind        TEXT        NOT NULL,
  source      TEXT        NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (server_id, addr)
);
CREATE INDEX server_ip_candidates_server ON server_ip_candidates(server_id);
