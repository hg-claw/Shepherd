package subgen

// OixCoreGroups are always emitted by the fixed oixCloud templates and are NOT
// user-selectable: they are the main proxy group, the domestic/catch-all groups,
// and the auto-test groups that other groups and the FINAL/MATCH rule reference.
var OixCoreGroups = map[string]bool{
	"Proxy":          true,
	"Domestic":       true,
	"Others":         true,
	"Auto - UrlTest": true,
	"Auto - Smart":   true,
}

// OixServiceGroups is the ordered list of user-selectable service groups in the
// fixed oixCloud templates. Order drives the editor checklist. Keep in sync with
// the [Proxy Group] section of templates/oix_surge.tmpl.
var OixServiceGroups = []string{
	"AdBlock", "AI Suite", "Netflix", "Disney Plus", "YouTube", "Max",
	"Spotify", "CN Mainland TV", "Asian TV", "Global TV", "Apple Push",
	"Apple Services", "Apple TV", "Telegram", "Google FCM", "Crypto",
	"Discord", "PayPal", "Microsoft", "Scholar", "Speedtest", "Steam",
	"TikTok", "miHoYo",
}

// isOixServiceGroup reports whether name is a selectable service group.
func isOixServiceGroup(name string) bool {
	for _, g := range OixServiceGroups {
		if g == name {
			return true
		}
	}
	return false
}

// normalizeServiceGroups drops any name that is not a selectable service group
// (core names, stale names), preserving input order. Defensive: a bad name can
// never strip an unintended part of the template.
func normalizeServiceGroups(names []string) []string {
	var out []string
	for _, n := range names {
		if isOixServiceGroup(n) {
			out = append(out, n)
		}
	}
	return out
}

// disabledServiceSet builds a name→true lookup of disabled service groups,
// ignoring non-service names.
func disabledServiceSet(names []string) map[string]bool {
	out := make(map[string]bool, len(names))
	for _, n := range names {
		if isOixServiceGroup(n) {
			out[n] = true
		}
	}
	return out
}
