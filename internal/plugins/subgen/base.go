package subgen

type Group struct {
	Name    string
	Type    string // "select" | "url-test"
	Members []string
}

// Rule is one routing entry in target-agnostic form. Exactly one of Ruleset /
// Native / Match is set, OR Final is true (the catch-all). Target is the policy
// or proxy-group name matched traffic is routed to.
type Rule struct {
	Ruleset string // remote rule-set folder name (blackmatrix7); a category may expand to several
	Native  string // built-in matcher emitted ~verbatim, e.g. "GEOIP,CN" or "RULE-SET,SYSTEM"
	Match   string // custom rule body, e.g. "DOMAIN-SUFFIX,example.com"
	Final   bool   // catch-all (Surge: FINAL / Clash: MATCH)
	Target  string
}

type Intermediate struct {
	Nodes        []Node
	Groups       []Group
	Rules        []Rule
	General      string // Surge [General] body; empty → renderer default
	MITM         string // Surge [MITM] body; empty → section omitted
	ClashGeneral string // Clash YAML preamble; empty → {mode: rule}
}

const autoSelectGroup = "Auto Select"
const mainProxyGroup = "PROXY"

// Assemble builds the target-agnostic model.
//
// Groups, in order: the main "PROXY" select (members = optional "Auto Select"
// then every node name), an "Auto Select" url-test (only if IncludeAutoSelect),
// then one switchable "select" group per category. A category group is named
// after the category; its members are the configured policy (first → default
// selection), PROXY, DIRECT, REJECT, then every node — de-duplicated.
//
// Rules (semantic): custom rules first (explicit policy), then one rule per
// category routed to the category's GROUP by name, then the catch-all (Final).
// The free-text General/MITM/ClashGeneral blocks ride along to the renderer,
// which resolves rule-set URLs for its own target.
func Assemble(nodes []Node, spec TemplateSpec) Intermediate {
	if custom, _ := ParseShareLinks(spec.CustomNodes); len(custom) > 0 {
		nodes = append(nodes, custom...)
	}
	im := Intermediate{Nodes: nodes, General: spec.General, MITM: spec.MITM, ClashGeneral: spec.ClashGeneral}

	allNames := make([]string, 0, len(nodes))
	for _, n := range nodes {
		allNames = append(allNames, n.Name)
	}

	mainMembers := []string{}
	if spec.IncludeAutoSelect {
		mainMembers = append(mainMembers, autoSelectGroup)
	}
	mainMembers = append(mainMembers, allNames...)
	im.Groups = append(im.Groups, Group{Name: mainProxyGroup, Type: "select", Members: mainMembers})
	if spec.IncludeAutoSelect {
		im.Groups = append(im.Groups, Group{Name: autoSelectGroup, Type: "url-test", Members: allNames})
	}

	for _, c := range spec.Categories {
		members := dedupeStrings(append([]string{c.Policy, mainProxyGroup, "DIRECT", "REJECT"}, allNames...))
		im.Groups = append(im.Groups, Group{Name: c.Name, Type: "select", Members: members})
	}

	for _, r := range spec.CustomRules {
		im.Rules = append(im.Rules, Rule{Match: r.Match, Target: r.Policy})
	}
	for _, c := range spec.Categories {
		cat, _ := categoryByName(c.Name) // categories are validated by ParseTemplate
		if cat.Native != "" {
			im.Rules = append(im.Rules, Rule{Native: cat.Native, Target: c.Name})
		} else {
			for _, folder := range cat.Rulesets {
				im.Rules = append(im.Rules, Rule{Ruleset: folder, Target: c.Name})
			}
		}
	}
	im.Rules = append(im.Rules, Rule{Final: true, Target: spec.Final})
	return im
}

// dedupeStrings drops later duplicates, preserving first-seen order. Keeps a
// category group's default policy from repeating when it equals one of the
// standard PROXY/DIRECT/REJECT members.
func dedupeStrings(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}
