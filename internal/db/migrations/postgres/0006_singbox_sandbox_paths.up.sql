-- Phase 3d sing-box plugin needs to write config + cert files under
-- /etc/shepherd-singbox/. Existing installs ran 0005 before sing-box
-- existed; backfill the sandbox setting if missing.
UPDATE settings SET value = value || E'\n/etc/shepherd-singbox'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/etc/shepherd-singbox%';
