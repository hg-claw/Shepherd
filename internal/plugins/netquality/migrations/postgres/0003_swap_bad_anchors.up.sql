-- Postgres mirror of 0003 — same UPDATE semantics, no syntax differences.
UPDATE netquality_targets
   SET host = '208.67.222.222',
       label = 'OpenDNS US'
 WHERE source = 'builtin' AND host = '8.8.8.8';

UPDATE netquality_targets
   SET host = '210.132.100.101',
       label = 'NTT Comms JP'
 WHERE source = 'builtin' AND host = '210.130.1.40';
