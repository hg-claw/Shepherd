package subgen

type Group struct {
	Name     string
	Type     string // "select" | "url-test"
	Members  []string
	Verbatim bool // user-defined: render members exactly, no auto-DIRECT fallback
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
	URLRewrite   string // Surge [URL Rewrite] body; empty → section omitted
	ClashGeneral string // Clash YAML preamble; empty → {mode: rule}
}

// Assemble builds the target-agnostic model for the fixed-template renderers.
// The base template (dler.io/oixCloud) owns the proxy-group taxonomy, the
// rule-sets, and the catch-all; Assemble carries only what the user customizes:
// the node set (selected + custom), the custom groups, the custom rules, and the
// free-text section bodies. spec.Categories no longer affects output.
func Assemble(nodes []Node, spec TemplateSpec) Intermediate {
	if custom, _ := ParseShareLinks(spec.CustomNodes); len(custom) > 0 {
		nodes = append(nodes, custom...)
	}
	dedupeNodeNames(nodes)
	im := Intermediate{
		Nodes:        nodes,
		General:      spec.General,
		MITM:         spec.MITM,
		URLRewrite:   spec.URLRewrite,
		ClashGeneral: spec.ClashGeneral,
	}
	for _, cg := range spec.CustomGroups {
		members := append([]string(nil), cg.Members...)
		im.Groups = append(im.Groups, Group{Name: cg.Name, Type: cg.Type, Members: members, Verbatim: true})
	}
	for _, r := range spec.CustomRules {
		im.Rules = append(im.Rules, Rule{Match: r.Match, Target: r.Policy})
	}
	return im
}
