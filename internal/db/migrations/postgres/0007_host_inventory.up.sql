CREATE TABLE host_inventory (
  server_id     BIGINT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cpu_physical  INTEGER,
  cpu_logical   INTEGER,
  cpu_model     TEXT,
  mem_total     BIGINT,
  disk_total    BIGINT,
  gpus_json     TEXT,
  updated_at    TIMESTAMPTZ NOT NULL
);
