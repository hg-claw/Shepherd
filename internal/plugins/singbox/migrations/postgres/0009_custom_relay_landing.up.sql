ALTER TABLE singbox_inbounds ADD COLUMN custom_upstream_url TEXT NOT NULL DEFAULT '';

ALTER TABLE singbox_inbounds DROP CONSTRAINT IF EXISTS singbox_inbounds_check;
ALTER TABLE singbox_inbounds DROP CONSTRAINT IF EXISTS singbox_inbounds_role_check;
ALTER TABLE singbox_inbounds
  ADD CONSTRAINT singbox_inbounds_relay_topology_check CHECK (
    (role = 'landing' AND upstream_inbound_id IS NULL AND custom_upstream_url = '') OR
    (role = 'relay' AND (
      (upstream_inbound_id IS NOT NULL AND custom_upstream_url = '') OR
      (upstream_inbound_id IS NULL AND custom_upstream_url <> '')
    ))
  );
