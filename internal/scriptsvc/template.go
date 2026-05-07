package scriptsvc

import (
	"bytes"
	"fmt"
	"regexp"
	"text/template"
)

var paramName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)

const maxRendered = 64 * 1024

func Render(content string, params []Param, args map[string]string) (string, error) {
	data := map[string]string{}
	for _, p := range params {
		if !paramName.MatchString(p.Name) {
			return "", fmt.Errorf("invalid param name %q", p.Name)
		}
		v, ok := args[p.Name]
		if !ok || v == "" {
			v = p.Default
		}
		if v == "" && p.Required {
			return "", fmt.Errorf("missing required param %q", p.Name)
		}
		data[p.Name] = v
	}
	tmpl, err := template.New("script").Option("missingkey=error").Parse(content)
	if err != nil {
		return "", fmt.Errorf("template parse: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("template exec: %w", err)
	}
	if buf.Len() > maxRendered {
		return "", fmt.Errorf("rendered exceeds %d bytes", maxRendered)
	}
	return buf.String(), nil
}
