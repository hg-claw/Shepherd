package subgen

import (
	"fmt"
	"io"
	"strings"

	"gopkg.in/yaml.v3"
)

// decodeClashMapping accepts exactly one YAML mapping document, with unique
// string keys at every level. yaml.Unmarshal alone silently ignores subsequent
// documents, and decoding into yaml.Node alone does not reject duplicate keys.
// An empty/comment-only extra is a no-op; an explicit null is not a mapping.
func decodeClashMapping(text string, allowEmpty bool) (map[string]any, error) {
	if allowEmpty && strings.TrimSpace(text) == "" {
		return map[string]any{}, nil
	}
	dec := yaml.NewDecoder(strings.NewReader(text))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		if err == io.EOF && allowEmpty {
			return map[string]any{}, nil
		}
		if err == io.EOF {
			return nil, fmt.Errorf("expected a YAML mapping, got an empty document")
		}
		return nil, err
	}
	var next yaml.Node
	if err := dec.Decode(&next); err != io.EOF {
		if err != nil {
			return nil, fmt.Errorf("invalid YAML after first document: %w", err)
		}
		return nil, fmt.Errorf("multiple YAML documents are not allowed")
	}
	if len(doc.Content) != 1 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("expected a YAML mapping at the top level")
	}
	if err := validateClashYAMLNode(doc.Content[0], make(map[*yaml.Node]bool)); err != nil {
		return nil, err
	}
	var out map[string]any
	// Decode resolves valid aliases and YAML merge keys before the explicit
	// configuration overlay. It also rejects invalid tags and cyclic aliases.
	if err := doc.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func validateClashYAMLNode(n *yaml.Node, visited map[*yaml.Node]bool) error {
	if n == nil || visited[n] {
		return nil
	}
	visited[n] = true
	if n.Kind == yaml.AliasNode {
		return validateClashYAMLNode(n.Alias, visited)
	}
	if n.Kind == yaml.MappingNode {
		keys := make(map[string]int, len(n.Content)/2)
		for i := 0; i < len(n.Content); i += 2 {
			key := n.Content[i]
			if key.Kind != yaml.ScalarNode || (key.ShortTag() != "!!str" && key.ShortTag() != "!!merge") {
				return fmt.Errorf("mapping key at line %d must be a string", key.Line)
			}
			if line, ok := keys[key.Value]; ok {
				return fmt.Errorf("duplicate key %q at line %d (first defined at line %d)", key.Value, key.Line, line)
			}
			keys[key.Value] = key.Line
		}
	}
	for _, child := range n.Content {
		if err := validateClashYAMLNode(child, visited); err != nil {
			return err
		}
	}
	return nil
}

// mergeClashGeneral applies the user's mapping after the fixed template has
// been rendered and filtered. Maps merge recursively; sequences, scalars and
// null replace the previous value. Unknown configuration keys are preserved.
// An empty overlay preserves the exact original bytes, including comments.
func mergeClashGeneral(base, extra string) (string, error) {
	baseMap, err := decodeClashMapping(base, false)
	if err != nil {
		return "", fmt.Errorf("invalid rendered Clash YAML: %w", err)
	}
	extraMap, err := decodeClashMapping(extra, true)
	if err != nil {
		return "", fmt.Errorf("bad clash_general: %w", err)
	}
	if len(extraMap) == 0 {
		return base, nil
	}
	mergeClashMappings(baseMap, extraMap)
	out, err := yaml.Marshal(baseMap)
	if err != nil {
		return "", fmt.Errorf("encode merged Clash YAML: %w", err)
	}
	// Check the actual emitted document too, not just the two input fragments.
	if _, err := decodeClashMapping(string(out), false); err != nil {
		return "", fmt.Errorf("invalid merged Clash YAML: %w", err)
	}
	return string(out), nil
}

func mergeClashMappings(dst, src map[string]any) {
	for key, value := range src {
		oldMap, oldIsMap := dst[key].(map[string]any)
		newMap, newIsMap := value.(map[string]any)
		if oldIsMap && newIsMap {
			mergeClashMappings(oldMap, newMap)
		} else {
			dst[key] = value
		}
	}
}
