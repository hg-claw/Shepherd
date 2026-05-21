-- No-op: removing a path from the sandbox setting on downgrade would be
-- punitive (live deploys may already rely on it). Leave the value alone.
SELECT 1;
