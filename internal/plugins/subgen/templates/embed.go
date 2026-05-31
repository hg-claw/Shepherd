// Package templates holds the embedded fixed Surge/Clash base templates
// (templatized dler.io/oixCloud configs). The renderers fill the {{...}}
// markers with the user's nodes + custom logic.
package templates

import _ "embed"

//go:embed oix_surge.tmpl
var Surge string

//go:embed oix_clash.tmpl
var Clash string
