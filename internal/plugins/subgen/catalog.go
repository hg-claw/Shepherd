package subgen

import "strings"

type Category struct {
	Name          string
	Rulesets      []string // blackmatrix7 folder names (remote RULE-SET)
	Native        string   // e.g. "GEOIP,CN" — client resolves natively
	DefaultPolicy string   // PROXY | DIRECT | REJECT
}

var UnifiedCategories = []Category{
	{Name: "Ad Block", Rulesets: []string{"AdvertisingLite"}, DefaultPolicy: "REJECT"},
	{Name: "AI Services", Rulesets: []string{"OpenAI"}, DefaultPolicy: "PROXY"},
	{Name: "Telegram", Rulesets: []string{"Telegram"}, DefaultPolicy: "PROXY"},
	{Name: "Google", Rulesets: []string{"Google"}, DefaultPolicy: "PROXY"},
	{Name: "Youtube", Rulesets: []string{"YouTube"}, DefaultPolicy: "PROXY"},
	{Name: "Github", Rulesets: []string{"GitHub"}, DefaultPolicy: "PROXY"},
	{Name: "Microsoft", Rulesets: []string{"Microsoft"}, DefaultPolicy: "PROXY"},
	{Name: "Apple", Rulesets: []string{"Apple"}, DefaultPolicy: "PROXY"},
	{Name: "Streaming", Rulesets: []string{"Netflix", "Disney", "HBO", "YouTube"}, DefaultPolicy: "PROXY"},
	{Name: "Social Media", Rulesets: []string{"Facebook", "Twitter", "TikTok", "Instagram"}, DefaultPolicy: "PROXY"},
	{Name: "Location:CN", Native: "GEOIP,CN", DefaultPolicy: "DIRECT"},
	{Name: "Private", Native: "RULE-SET,SYSTEM", DefaultPolicy: "DIRECT"},
}

var PredefinedTemplates = map[string][]string{
	"minimal":       {"Location:CN", "Private", "Ad Block"},
	"balanced":      {"Location:CN", "Private", "Ad Block", "Github", "Google", "Youtube", "AI Services", "Telegram"},
	"comprehensive": categoryNames(),
}

func categoryNames() []string {
	out := make([]string, 0, len(UnifiedCategories))
	for _, c := range UnifiedCategories {
		out = append(out, c.Name)
	}
	return out
}

func categoryByName(name string) (Category, bool) {
	for _, c := range UnifiedCategories {
		if c.Name == name {
			return c, true
		}
	}
	return Category{}, false
}

// rulesetDir maps a target to the blackmatrix7 rule directory + file ext.
// Surge and ShadowRocket both consume Surge-format .list files; Clash consumes
// .yaml rule-provider files.
func rulesetDir(target string) (dir, ext string) {
	if target == "clash" {
		return "Clash", "yaml"
	}
	return "Surge", "list"
}

// rulesetURL builds the blackmatrix7 raw URL for one folder + target.
func rulesetURL(folder, target, base string) string {
	dir, ext := rulesetDir(target)
	base = strings.TrimRight(base, "/")
	return base + "/rule/" + dir + "/" + folder + "/" + folder + "." + ext
}

// ResolveRuleLines turns one category + policy into the rule line(s) for a
// target — remote categories become RULE-SET URLs, native ones their directive.
// Used by the /categories admin endpoint to show each category's rule lines.
func ResolveRuleLines(category, policy, target, base string) []string {
	c, ok := categoryByName(category)
	if !ok {
		return nil
	}
	if c.Native != "" {
		return []string{c.Native + "," + policy}
	}
	var out []string
	for _, rs := range c.Rulesets {
		out = append(out, "RULE-SET,"+rulesetURL(rs, target, base)+","+policy)
	}
	return out
}

const DefaultRulesetBase = "https://raw.githubusercontent.com/blackmatrix7/ios_rule_script/master"
