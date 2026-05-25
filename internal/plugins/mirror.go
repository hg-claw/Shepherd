package plugins

import (
	"context"

	"github.com/jmoiron/sqlx"
)

// CNMirrorSettingKey is the name of the global toggle stored in the
// settings table. Value is the string "true" / "false" (or any of
// SettingsStore.GetBool's truthy aliases). When true, plugin Releaser
// fetches prepend this prefix to the GitHub asset download URL.
const CNMirrorSettingKey = "cn_mirror_enabled"

// CNMirrorPrefix is the relay everyone goes through. Kept here as a
// const so swapping it (or adding more) is a one-line change.
const CNMirrorPrefix = "https://gh-proxy.com/"

// LoadCNMirror returns the prefix to apply to github.com download URLs
// when the operator has the CN-mirror setting on, else "".
//
// Why this lives in the plugins package and not serversvc: both
// singbox and xray plugins import `plugins` already (for the Plugin
// interface). Putting the helper here means they don't gain a new
// dependency tree just to read one setting. Falls back to "" on any
// query error — a transient DB hiccup shouldn't change download
// routing.
func LoadCNMirror(ctx context.Context, db *sqlx.DB) string {
	var v string
	if err := db.GetContext(ctx, &v,
		"SELECT value FROM settings WHERE key=$1", CNMirrorSettingKey); err != nil {
		return ""
	}
	if v == "true" || v == "1" {
		return CNMirrorPrefix
	}
	return ""
}
