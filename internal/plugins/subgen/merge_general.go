package subgen

import (
	"fmt"
	"strings"
)

// parseGeneral restricts the free-text field to one section body. In particular,
// a second [General] or [Rule] section must not turn an override into injection.
func parseGeneral(text string) (map[string]string, []string, error) {
	values := make(map[string]string)
	var order []string
	for i, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if !safeRuleText(line) {
			return nil, nil, fmt.Errorf("general line %d: control characters are not allowed", i+1)
		}
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.ToLower(strings.TrimSpace(key))
		if !ok || key == "" || strings.ContainsAny(key, "[] \t\r") {
			return nil, nil, fmt.Errorf("general line %d: expected key = value without section headers", i+1)
		}
		if _, exists := values[key]; exists {
			return nil, nil, fmt.Errorf("general line %d: duplicate key %q", i+1, key)
		}
		values[key] = strings.TrimSpace(value)
		order = append(order, key)
	}
	return values, order, nil
}

// mergeGeneral replaces existing keys in [General], then appends new keys in
// user order. Other sections (including WireGuard dns-server) are untouched.
func mergeGeneral(conf, extra string) (string, error) {
	values, order, err := parseGeneral(extra)
	if err != nil {
		return "", err
	}
	if len(values) == 0 {
		return conf, nil
	}
	var out []string
	inGeneral := false
	seen := make(map[string]bool)
	appendNew := func() {
		for _, key := range order {
			if !seen[key] {
				out = append(out, key+" = "+values[key])
				seen[key] = true
			}
		}
	}
	for _, line := range strings.Split(conf, "\n") {
		trim := strings.TrimSpace(line)
		if strings.HasPrefix(trim, "[") && strings.HasSuffix(trim, "]") {
			if inGeneral {
				appendNew()
			}
			inGeneral = strings.EqualFold(trim, "[General]")
		}
		if inGeneral && !strings.HasPrefix(trim, "#") && !strings.HasPrefix(trim, ";") {
			key, _, ok := strings.Cut(trim, "=")
			key = strings.ToLower(strings.TrimSpace(key))
			if value, replace := values[key]; ok && replace {
				if !seen[key] {
					out = append(out, key+" = "+value)
					seen[key] = true
				}
				continue
			}
		}
		out = append(out, line)
	}
	if inGeneral {
		appendNew()
	}
	return strings.Join(out, "\n"), nil
}
