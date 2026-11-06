package subgen

import (
	"fmt"
	"io"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

// guardClashUDP adds a UDP-only rejection immediately after each rule whose
// policy may resolve to a proxy without UDP support. Mihomo skips such proxies
// for UDP, so a rejection only at the end of rules would allow an earlier DIRECT
// rule to consume the request. UDP-capable proxies and groups selecting DIRECT
// consume the original rule first and never reach its guard.
//
// Call this AFTER all configuration overlays. Original bytes are not marshaled:
// only new, single-quoted rule lines are inserted. Missing/null rules, aliases,
// nonempty flow sequences and multiline rules are rejected rather than guessed
// at. An explicitly empty sequence is a no-op. Adjacent identical guards make
// repeated calls idempotent. This validates rule structure, not provider names,
// proxy existence or every matcher payload; Mihomo remains their validator.
func guardClashUDP(conf string) (string, error) {
	// yaml.Node counts these as line breaks too. Supporting LF and CRLF only
	// keeps its line numbers unambiguous when indexing the original bytes.
	if strings.ContainsAny(conf, "\u0085\u2028\u2029") || strings.Contains(strings.ReplaceAll(conf, "\r\n", ""), "\r") {
		return "", fmt.Errorf("UDP guards require LF or CRLF YAML line endings")
	}
	dec := yaml.NewDecoder(strings.NewReader(conf))
	var doc, next yaml.Node
	if err := dec.Decode(&doc); err != nil {
		return "", fmt.Errorf("decode Clash YAML for UDP guards: %w", err)
	}
	if err := dec.Decode(&next); err != io.EOF {
		return "", fmt.Errorf("UDP guards require exactly one YAML document")
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return "", fmt.Errorf("UDP guards require a YAML mapping")
	}
	if err := validateClashYAMLNode(doc.Content[0], make(map[*yaml.Node]bool)); err != nil {
		return "", fmt.Errorf("invalid Clash YAML for UDP guards: %w", err)
	}
	var config map[string]any
	if err := doc.Decode(&config); err != nil {
		return "", err
	}
	// A selected PASS adapter intentionally continues rule evaluation. A guard
	// cannot distinguish that from an unsupported-UDP skip, so do not silently
	// change its semantics. Literal PASS rules remain supported.
	for _, key := range []string{"proxies", "proxy-groups"} {
		entries, _ := config[key].([]any)
		for _, value := range entries {
			entry, _ := value.(map[string]any)
			if kind, _ := entry["type"].(string); strings.EqualFold(kind, "pass") {
				return "", fmt.Errorf("PASS adapters in groups are incompatible with UDP rejection guards; use a literal PASS rule")
			}
			members, _ := entry["proxies"].([]any)
			for _, member := range members {
				if member == "PASS" {
					return "", fmt.Errorf("PASS group members are incompatible with UDP rejection guards; use a literal PASS rule")
				}
			}
		}
	}
	var rules *yaml.Node
	for i := 0; i < len(doc.Content[0].Content); i += 2 {
		if doc.Content[0].Content[i].Value == "rules" {
			rules = doc.Content[0].Content[i+1]
			break
		}
	}
	if rules == nil || rules.Kind != yaml.SequenceNode || rules.ShortTag() != "!!seq" {
		return "", fmt.Errorf("UDP guards require an explicit rules sequence (missing/null rules are not supported)")
	}
	if len(rules.Content) == 0 {
		return conf, nil
	}
	if rules.Style&yaml.FlowStyle != 0 {
		return "", fmt.Errorf("UDP guards require block-style rules")
	}

	lines := strings.SplitAfter(conf, "\n")
	type ruleLine struct {
		index  int
		indent string
		value  string
		guard  string
	}
	entries := make([]ruleLine, 0, len(rules.Content))
	lastLine := 0
	for i, rule := range rules.Content {
		if rule.Kind != yaml.ScalarNode || rule.ShortTag() != "!!str" || rule.Style&(yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
			return "", fmt.Errorf("rules[%d] must be a single-line string", i)
		}
		if rule.Line <= lastLine || rule.Line > len(lines) {
			return "", fmt.Errorf("rules[%d] has an invalid source location", i)
		}
		lastLine = rule.Line
		line := strings.TrimSuffix(strings.TrimSuffix(lines[rule.Line-1], "\n"), "\r")
		indent := line[:len(line)-len(strings.TrimLeft(line, " "))]
		if !strings.HasPrefix(line[len(indent):], "- ") {
			return "", fmt.Errorf("rules[%d] must occupy its own block sequence line", i)
		}
		// Parsing just this physical line rejects quoted/plain scalars spanning
		// multiple lines, including YAML's escaped or folded line continuations.
		var single yaml.Node
		if err := yaml.Unmarshal([]byte(line), &single); err != nil || len(single.Content) != 1 || single.Content[0].Kind != yaml.SequenceNode || len(single.Content[0].Content) != 1 {
			return "", fmt.Errorf("rules[%d] cannot be located on a single source line", i)
		}
		located := single.Content[0].Content[0]
		if located.Kind != yaml.ScalarNode || located.ShortTag() != "!!str" || located.Value != rule.Value || located.Column != rule.Column {
			return "", fmt.Errorf("rules[%d] does not match its single source line", i)
		}
		guard, err := clashUDPGuardRule(rule.Value)
		if err != nil {
			return "", fmt.Errorf("rules[%d] at line %d: %w", i, rule.Line, err)
		}
		entries = append(entries, ruleLine{rule.Line - 1, indent, rule.Value, guard})
	}

	insertions := make(map[int]string)
	for i, entry := range entries {
		if entry.guard == "" || (i+1 < len(entries) && strings.TrimSpace(entries[i+1].value) == entry.guard) {
			continue
		}
		insertions[entry.index] = entry.indent + "- '" + strings.ReplaceAll(entry.guard, "'", "''") + "'"
	}
	if len(insertions) == 0 {
		return conf, nil
	}
	defaultEOL := "\n"
	if firstLF := strings.IndexByte(conf, '\n'); firstLF > 0 && conf[firstLF-1] == '\r' {
		defaultEOL = "\r\n"
	}
	var out strings.Builder
	out.Grow(len(conf))
	for i, line := range lines {
		out.WriteString(line)
		guard, ok := insertions[i]
		if !ok {
			continue
		}
		switch {
		case strings.HasSuffix(line, "\r\n"):
			out.WriteString(guard + "\r\n")
		case strings.HasSuffix(line, "\n"):
			out.WriteString(guard + "\n")
		default:
			// Preserve the original absence of a final newline too.
			out.WriteString(defaultEOL + guard)
		}
	}
	return out.String(), nil
}

// clashUDPGuardRule removes the policy, not the last comma of a logical
// expression. no-resolve belongs to the matcher inside the generated AND.
func clashUDPGuardRule(rule string) (string, error) {
	for _, r := range rule {
		if unicode.IsControl(r) || r == '\u2028' || r == '\u2029' {
			return "", fmt.Errorf("rule contains a line break or control character")
		}
	}
	rule = strings.TrimSpace(rule)
	kind, _, ok := strings.Cut(rule, ",")
	if !ok {
		return "", fmt.Errorf("rule is missing its policy")
	}
	kind = strings.ToUpper(strings.TrimSpace(kind))
	var condition, policy string
	switch kind {
	case "MATCH":
		fields := strings.Split(rule, ",")
		if len(fields) != 2 {
			return "", fmt.Errorf("MATCH requires exactly one policy")
		}
		policy = strings.TrimSpace(fields[1])
	case "AND", "OR", "NOT", "DOMAIN-REGEX", "PROCESS-NAME-REGEX", "PROCESS-PATH-REGEX":
		// Logical expressions and regex payloads can contain commas; none
		// accepts trailing params, so the policy is the final field.
		last := strings.LastIndexByte(rule, ',')
		condition, policy = strings.TrimSpace(rule[:last]), strings.TrimSpace(rule[last+1:])
	default:
		fields := strings.Split(rule, ",")
		if len(fields) < 3 {
			return "", fmt.Errorf("rule requires a matcher, payload and policy")
		}
		condition = strings.TrimSpace(fields[0]) + "," + strings.TrimSpace(fields[1])
		policy = strings.TrimSpace(fields[2])
		for _, param := range fields[3:] {
			param = strings.TrimSpace(param)
			if param != "no-resolve" && param != "src" {
				return "", fmt.Errorf("unsupported rule parameter %q", param)
			}
			condition += "," + param
		}
	}
	if policy == "" {
		return "", fmt.Errorf("rule policy must not be empty")
	}
	if kind != "MATCH" {
		if err := validateClashUDPCondition(condition, 0); err != nil {
			return "", err
		}
	}
	switch policy {
	case "DIRECT", "REJECT", "REJECT-DROP", "PASS":
		return "", nil
	}
	if kind == "MATCH" {
		return "NETWORK,udp,REJECT", nil
	}
	// Resolving an IP during the first match mutates metadata.DstIP. Negated
	// IP/provider tests may then change truth value when the guard repeats it.
	// Reject this advanced form rather than silently claim fail-closed behavior.
	upper := strings.ToUpper(condition)
	if (kind == "AND" || kind == "OR" || kind == "NOT") && strings.Contains(upper, "NOT,") {
		for _, mutable := range []string{"IP-CIDR", "IP-SUFFIX", "IP-ASN", "GEOIP", "RULE-SET"} {
			if strings.Contains(upper, mutable+",") {
				return "", fmt.Errorf("negated IP/provider logic cannot be safely repeated for UDP rejection")
			}
		}
	}
	guardCondition := "AND,((NETWORK,udp),(" + condition + "))"
	if err := validateClashUDPCondition(guardCondition, 0); err != nil {
		return "", fmt.Errorf("matcher cannot be embedded safely in a UDP guard: %w", err)
	}
	return guardCondition + ",REJECT", nil
}

// Only matcher forms which can safely be embedded are accepted. In particular,
// SUB-RULE is control flow, not a proxy policy, and must not be transformed as if
// it were an ordinary matcher. Unknown forms fail closed instead of being lost.
func validateClashUDPCondition(condition string, depth int) error {
	if depth > 64 {
		return fmt.Errorf("logical rule nesting is too deep")
	}
	kind, payload, ok := strings.Cut(strings.TrimSpace(condition), ",")
	if !ok || strings.TrimSpace(payload) == "" {
		return fmt.Errorf("rule matcher requires a nonempty payload")
	}
	kind = strings.ToUpper(strings.TrimSpace(kind))
	payload = strings.TrimSpace(payload)
	switch kind {
	case "AND", "OR", "NOT":
		if len(payload) < 2 || payload[0] != '(' || payload[len(payload)-1] != ')' {
			return fmt.Errorf("logical matcher requires a parenthesized condition list")
		}
		remaining := strings.TrimSpace(payload[1 : len(payload)-1])
		count := 0
		for remaining != "" {
			if remaining[0] != '(' {
				return fmt.Errorf("logical matcher requires parenthesized subconditions")
			}
			balance, end := 0, -1
			for i, r := range remaining {
				if r == '(' {
					balance++
				} else if r == ')' {
					balance--
					if balance == 0 {
						end = i
						break
					}
				}
			}
			if end < 0 {
				return fmt.Errorf("logical matcher has unbalanced parentheses")
			}
			if err := validateClashUDPCondition(remaining[1:end], depth+1); err != nil {
				return err
			}
			count++
			remaining = strings.TrimSpace(remaining[end+1:])
			if remaining != "" {
				if remaining[0] != ',' || strings.TrimSpace(remaining[1:]) == "" {
					return fmt.Errorf("logical matcher has an invalid condition separator")
				}
				remaining = strings.TrimSpace(remaining[1:])
			}
		}
		if count == 0 || (kind == "NOT" && count != 1) {
			return fmt.Errorf("logical matcher has an invalid condition count")
		}
	case "DOMAIN-REGEX", "PROCESS-NAME-REGEX", "PROCESS-PATH-REGEX":
		// Mihomo logical syntax uses parentheses as delimiters too. Reject
		// unbalanced patterns rather than changing their matching semantics.
		balance := 0
		for _, r := range payload {
			if r == '(' {
				balance++
			}
			if r == ')' {
				balance--
			}
			if balance < 0 {
				return fmt.Errorf("regex cannot be safely nested in a UDP guard")
			}
		}
		if balance != 0 {
			return fmt.Errorf("regex cannot be safely nested in a UDP guard")
		}
	case "DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "DOMAIN-WILDCARD", "GEOSITE",
		"IP-CIDR", "IP-CIDR6", "IP-SUFFIX", "IP-ASN", "GEOIP",
		"SRC-GEOIP", "SRC-IP-ASN", "SRC-IP-CIDR", "SRC-IP-SUFFIX",
		"SRC-PORT", "DST-PORT", "IN-PORT", "IN-TYPE", "IN-USER", "IN-NAME",
		"PROCESS-PATH", "PROCESS-PATH-WILDCARD", "PROCESS-NAME", "PROCESS-NAME-WILDCARD",
		"NETWORK", "UID", "DSCP", "RULE-SET":
		fields := strings.Split(payload, ",")
		if strings.TrimSpace(fields[0]) == "" {
			return fmt.Errorf("matcher requires a nonempty payload")
		}
		for _, param := range fields[1:] {
			if strings.TrimSpace(param) != "no-resolve" && strings.TrimSpace(param) != "src" {
				return fmt.Errorf("matcher parameters must be no-resolve or src")
			}
		}
	default:
		return fmt.Errorf("unsupported UDP guard matcher %q", kind)
	}
	return nil
}
