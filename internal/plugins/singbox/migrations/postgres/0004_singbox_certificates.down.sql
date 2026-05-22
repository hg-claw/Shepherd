-- Drop the FK added in the up before the table it references.
ALTER TABLE IF EXISTS singbox_inbounds
  DROP CONSTRAINT IF EXISTS singbox_inbounds_cert_id_fkey;
DROP TABLE IF EXISTS singbox_certificates;
