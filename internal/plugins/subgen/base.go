package subgen

import "sort"

type Group struct {
	Name    string
	Type    string // "select" | "url-test"
	Members []string
}

type Intermediate struct {
	Nodes  []Node
	Groups []Group
	Rules  []string // FINAL last
}

const autoSelectGroup = "Auto Select"
const mainProxyGroup = "PROXY"

// Assemble builds the target-agnostic model. Groups: the main manual
// "PROXY" select (members = auto + per-country groups + all node names),
// an "Auto Select" url-test over all nodes, and one url-test per country
// when GroupByCountry. Rules: custom rules first, then category rules,
// then FINAL.
func Assemble(nodes []Node, spec TemplateSpec, target, rulesetBase string) Intermediate {
	im := Intermediate{Nodes: nodes}
	allNames := make([]string, 0, len(nodes))
	byCountry := map[string][]string{}
	for _, n := range nodes {
		allNames = append(allNames, n.Name)
		byCountry[n.Country] = append(byCountry[n.Country], n.Name)
	}

	mainMembers := []string{}
	if spec.IncludeAutoSelect {
		im.Groups = append(im.Groups, Group{Name: autoSelectGroup, Type: "url-test", Members: allNames})
		mainMembers = append(mainMembers, autoSelectGroup)
	}
	if spec.GroupByCountry {
		countries := make([]string, 0, len(byCountry))
		for c := range byCountry {
			if c != "" {
				countries = append(countries, c)
			}
		}
		sort.Strings(countries)
		for _, c := range countries {
			gname := countryFlag(c) + " " + c
			im.Groups = append(im.Groups, Group{Name: gname, Type: "url-test", Members: byCountry[c]})
			mainMembers = append(mainMembers, gname)
		}
	}
	mainMembers = append(mainMembers, allNames...)
	im.Groups = append([]Group{{Name: mainProxyGroup, Type: "select", Members: mainMembers}}, im.Groups...)

	for _, r := range spec.CustomRules {
		im.Rules = append(im.Rules, r.Match+","+r.Policy)
	}
	for _, c := range spec.Categories {
		im.Rules = append(im.Rules, ResolveRuleLines(c.Name, c.Policy, target, rulesetBase)...)
	}
	im.Rules = append(im.Rules, "FINAL,"+spec.Final)
	return im
}
