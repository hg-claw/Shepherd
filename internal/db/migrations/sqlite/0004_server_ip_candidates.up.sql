CREATE TABLE server_ip_candidates (
  server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  addr        TEXT    NOT NULL,
  kind        TEXT    NOT NULL,  -- public | private | cgnat | vpn
  source      TEXT    NOT NULL,  -- interface name (en0, eth0) or 'ipify' etc.
  detected_at TIMESTAMP NOT NULL,
  PRIMARY KEY (server_id, addr)
);
CREATE INDEX server_ip_candidates_server ON server_ip_candidates(server_id);
