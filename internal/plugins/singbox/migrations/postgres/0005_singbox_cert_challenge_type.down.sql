-- PostgreSQL supports DROP COLUMN directly (no table-recreate needed unlike SQLite).
ALTER TABLE singbox_certificates DROP COLUMN IF EXISTS challenge_type;
