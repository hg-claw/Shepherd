DELETE FROM settings WHERE key IN (
  'file_sandbox_enabled','file_sandbox_paths','audit_retention_days',
  'pty_recording_enabled','pty_max_concurrent_per_admin',
  'file_upload_max_bytes','file_chunk_bytes'
);
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS script_run_targets;
DROP TABLE IF EXISTS script_runs;
DROP TABLE IF EXISTS scripts;
DROP TABLE IF EXISTS pty_sessions;
