#!/usr/bin/env bash
# Guard against hardcoded UI values that bypass the design tokens.
# Allowlist an exceptional line with a trailing `ui-token-ignore` comment.
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=web/src
fail=0

check() {
  local desc=$1 pattern=$2
  local hits
  hits=$(grep -rnE "$pattern" "$SRC" --include='*.tsx' --include='*.ts' | grep -v 'ui-token-ignore' || true)
  if [ -n "$hits" ]; then
    printf '✗ %s:\n%s\n\n' "$desc" "$hits"
    fail=1
  fi
}

check "arbitrary font size (use text-2xs/xs/sm/lg/title/display)" \
  'text-\[[0-9.]+px\]'
check "raw Tailwind palette colour (use semantic tokens)" \
  '(bg|text|border|ring|fill|stroke)-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-[0-9]+'
check "hardcoded hex colour class (use tokens)" \
  '\[#[0-9a-fA-F]{3,8}\]'

if [ "$fail" -eq 0 ]; then echo "✓ UI token check passed"; fi
exit "$fail"
