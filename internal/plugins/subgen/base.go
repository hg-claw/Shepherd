package subgen

type Group struct {
	Name    string
	Type    string // "select" | "url-test"
	Members []string
}

type Intermediate struct {
	Nodes   []Node
	Groups  []Group
	Rules   []string // FINAL last
	General string   // raw [General] body; empty → renderer default
	MITM    string   // raw [MITM] body; empty → section omitted
}

const autoSelectGroup = "Auto Select"
const mainProxyGroup = "PROXY"

// Assemble builds the target-agnostic model.
//
// Groups, in order: the main "PROXY" select (members = optional "Auto Select"
// then every node name), an "Auto Select" url-test (only if IncludeAutoSelect),
// then one switchable "select" group per category. A category group is named
// after the category; its members are the configured policy (first → the
// default selection), PROXY, DIRECT, REJECT, then every node — de-duplicated.
//
// Rules: custom rules first (verbatim, explicit policy), then one rule per
// category routed to the category's GROUP by name (so clients can re-route it),
// then FINAL. The free-text General/MITM blocks ride along to the renderer.
func Assemble(nodes []Node, spec TemplateSpec, target, rulesetBase string) Intermediate {
	im := Intermediate{Nodes: nodes, General: spec.General, MITM: spec.MITM}

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
		im.Rules = append(im.Rules, r.Match+","+r.Policy)
	}
	for _, c := range spec.Categories {
		// Pass the category name as the rule target so the last field is the
		// group name (RULE-SET,<url>,Telegram / GEOIP,CN,Location:CN).
		im.Rules = append(im.Rules, ResolveRuleLines(c.Name, c.Name, target, rulesetBase)...)
	}
	im.Rules = append(im.Rules, "FINAL,"+spec.Final)
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
