-- 0002_host_targets: per-host target selection.
--
-- Before this migration every enabled host sampled every globally-enabled
-- target. That's fine on a one-host install but loses fidelity when an
-- admin wants the singapore server to skip China ISPs and vice-versa.
--
-- Model: sparse opt-in table. A row's presence + enabled=1 means "this
-- host samples this target"; row absence means "skip". On the host's
-- first enable transition we seed the table with all enabled builtin
-- targets so the operator gets the previous default behaviour for free.

CREATE TABLE netquality_host_targets (
  server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES netquality_targets(id) ON DELETE CASCADE,
  enabled   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (server_id, target_id)
);
CREATE INDEX netquality_host_targets_target ON netquality_host_targets(target_id);
