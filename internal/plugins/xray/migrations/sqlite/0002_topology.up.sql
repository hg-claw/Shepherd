CREATE TABLE xray_host_topology (
  server_id           INTEGER PRIMARY KEY
                        REFERENCES servers(id) ON DELETE CASCADE,
  role                TEXT    NOT NULL CHECK (role IN ('landing', 'relay')),
  upstream_server_id  INTEGER REFERENCES xray_host_topology(server_id) ON DELETE RESTRICT,
  updated_at          TIMESTAMP NOT NULL,
  CHECK (
    (role = 'landing' AND upstream_server_id IS NULL) OR
    (role = 'relay'   AND upstream_server_id IS NOT NULL)
  )
);
CREATE INDEX xray_host_topology_upstream ON xray_host_topology(upstream_server_id);

-- Backfill: every existing xray plugin_host is treated as a landing.
INSERT INTO xray_host_topology(server_id, role, upstream_server_id, updated_at)
SELECT server_id, 'landing', NULL, COALESCE(updated_at, CURRENT_TIMESTAMP)
FROM plugin_hosts
WHERE plugin_id = 'xray'
ON CONFLICT(server_id) DO NOTHING;
