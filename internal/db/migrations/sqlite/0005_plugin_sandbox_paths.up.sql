-- Append plugin-required paths to the file_sandbox_paths setting if missing.
-- Each UPDATE is a no-op when the path is already present (admin may have
-- added it manually, or this migration ran on a fresh install that already
-- included the path from the updated 0002 default).
--
-- Using char(10) for newlines because sqlite single-quoted strings don't
-- interpret \n. The serversvc.GetLines helper tolerates both forms but new
-- writes should use real newlines.

UPDATE settings SET value = value || char(10) || '/etc/shepherd-xray'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/etc/shepherd-xray%';
UPDATE settings SET value = value || char(10) || '/etc/systemd/system'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/etc/systemd/system%';
UPDATE settings SET value = value || char(10) || '/Library/LaunchDaemons'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/Library/LaunchDaemons%';
UPDATE settings SET value = value || char(10) || '/usr/local/bin'
  WHERE key = 'file_sandbox_paths' AND value NOT LIKE '%/usr/local/bin%';
