-- Downgrade reverts the two anchors. Same WHERE guard so we don't
-- touch operator-edited rows.
UPDATE netquality_targets
   SET host = '8.8.8.8', label = 'Google 8.8.8.8'
 WHERE source = 'builtin' AND host = '208.67.222.222';

UPDATE netquality_targets
   SET host = '210.130.1.40', label = 'Japan IIJ'
 WHERE source = 'builtin' AND host = '210.132.100.101';
