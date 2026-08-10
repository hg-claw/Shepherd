ALTER TABLE singbox_inbounds ADD COLUMN ssh_forward_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE singbox_inbounds ADD COLUMN ssh_host TEXT NOT NULL DEFAULT '';
ALTER TABLE singbox_inbounds ADD COLUMN ssh_port INTEGER NOT NULL DEFAULT 22;
ALTER TABLE singbox_inbounds ADD COLUMN ssh_username TEXT NOT NULL DEFAULT '';
ALTER TABLE singbox_inbounds ADD COLUMN ssh_private_key TEXT NOT NULL DEFAULT '';
ALTER TABLE singbox_inbounds ADD COLUMN ssh_use_localhost BOOLEAN NOT NULL DEFAULT FALSE;
