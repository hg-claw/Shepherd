-- See sqlite/0005_plugin_sandbox_paths.up.sql for rationale.
UPDATE settings SET value = value || E'\n/etc/shepherd-xray'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/etc/shepherd-xray%';
UPDATE settings SET value = value || E'\n/etc/systemd/system'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/etc/systemd/system%';
UPDATE settings SET value = value || E'\n/Library/LaunchDaemons'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/Library/LaunchDaemons%';
UPDATE settings SET value = value || E'\n/usr/local/bin'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/usr/local/bin%';
