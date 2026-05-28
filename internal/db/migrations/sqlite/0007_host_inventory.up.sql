CREATE TABLE host_inventory (
  server_id     INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  cpu_physical  INTEGER,
  cpu_logical   INTEGER,
  cpu_model     TEXT,
  mem_total     INTEGER,
  disk_total    INTEGER,
  gpus_json     TEXT,
  updated_at    TIMESTAMP NOT NULL
);
