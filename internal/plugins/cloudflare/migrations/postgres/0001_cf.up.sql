-- Tracks DNS records owned by Shepherd for each managed server. record_id is
-- the upstream Cloudflare record ID; we keep it so we can update / delete
-- without re-querying CF by name.
CREATE TABLE cf_host_domains (
  id         BIGSERIAL PRIMARY KEY,
  server_id  BIGINT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  zone_id    TEXT   NOT NULL,
  record_id  TEXT,                -- nullable until CF round-trip succeeds
  domain     TEXT   NOT NULL,     -- full FQDN
  type       TEXT   NOT NULL DEFAULT 'A',
  content    TEXT   NOT NULL,     -- IP for A, hostname for CNAME
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(server_id, zone_id, domain)
);
CREATE INDEX cf_host_domains_server ON cf_host_domains(server_id);
