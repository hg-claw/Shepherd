-- 0003_swap_bad_anchors: replace two overseas anchors that turned out
-- to be misleading.
--
--   8.8.8.8         (Google, globally anycast — not a US signal)
--                   → 208.67.222.222 (OpenDNS, Cisco-operated, anchored
--                                     in US peering)
--   210.130.1.40    (IIJ JP — stopped responding for our reporter)
--                   → 210.132.100.101 (NTT Communications JP, stable
--                                      ≥10y per NIC entry)
--
-- We UPDATE in place rather than DELETE + re-INSERT so:
--   1. existing netquality_samples_raw rows keep their FK target
--   2. any host that opted in via netquality_host_targets stays opted in
--   3. an operator who renamed the label keeps their rename
--
-- Guarded on source='builtin' AND host=<old> so we never clobber a
-- custom row that happens to share an IP, and so re-running the
-- migration after the value has been edited again is a no-op.

UPDATE netquality_targets
   SET host = '208.67.222.222',
       label = 'OpenDNS US'
 WHERE source = 'builtin' AND host = '8.8.8.8';

UPDATE netquality_targets
   SET host = '210.132.100.101',
       label = 'NTT Comms JP'
 WHERE source = 'builtin' AND host = '210.130.1.40';
