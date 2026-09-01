-- mieru plugin writes /etc/shepherd-mieru/server.json. Existing installs
-- ran 0006 before mieru existed; backfill the sandbox setting if missing.
UPDATE settings SET value = value || E'\n/etc/shepherd-mieru'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/etc/shepherd-mieru%';
