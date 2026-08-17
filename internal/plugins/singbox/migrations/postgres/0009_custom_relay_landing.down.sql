ALTER TABLE singbox_inbounds DROP CONSTRAINT IF EXISTS singbox_inbounds_relay_topology_check;
ALTER TABLE singbox_inbounds
  ADD CONSTRAINT singbox_inbounds_role_check CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL) OR
    (role = 'relay' AND upstream_inbound_id IS NOT NULL)
  );
ALTER TABLE singbox_inbounds DROP COLUMN IF EXISTS custom_upstream_url;
