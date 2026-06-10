#!/usr/bin/env node
// Vendors xterm.js assets into src/console/xterm-assets.ts so the console
// terminal works without reaching cdn.jsdelivr.net at runtime (the WebView
// html is fully self-contained; only the Shepherd server must be reachable).
//
// Regenerate with:  node scripts/vendor-xterm.mjs   (run from mobile/)
//
// Pinned versions / sources:
//   @xterm/xterm@5.5.0      lib/xterm.min.js, css/xterm.min.css
//   @xterm/addon-fit@0.10.0 lib/addon-fit.min.js
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCES = {
  XTERM_JS: {
    url: 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js',
    minBytes: 200_000, // ~280KB minified
    check: (s) => s.includes('Terminal'),
  },
  XTERM_CSS: {
    url: 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css',
    minBytes: 2_000,
    check: (s) => s.includes('.xterm'),
  },
  ADDON_FIT_JS: {
    url: 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js',
    minBytes: 500,
    check: (s) => s.includes('FitAddon'),
  },
}

async function fetchAsset(name, { url, minBytes, check }) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${url}`)
  const body = await res.text()
  if (body.length < minBytes) throw new Error(`${name}: too small (${body.length}B < ${minBytes}B) — truncated download?`)
  if (/^\s*</.test(body) && !name.endsWith('CSS')) throw new Error(`${name}: looks like an HTML error page, not JS`)
  if (!check(body)) throw new Error(`${name}: content sanity check failed (marker string missing)`)
  return body
}

// Make the payload safe to inline inside an HTML <script> (or <style>) tag:
// the HTML parser would end the tag at a literal '</script' regardless of JS
// string context. '<\/' inside JS strings/regexes evaluates identically to
// '</', so the replacement is behavior-preserving for the minified JS.
function escapeForInlineHtml(s) {
  return s.replace(/<\/(script|style)/gi, '<\\/$1')
}

// JSON.stringify emits a valid TS double-quoted string literal, except that
// U+2028/U+2029 (legal raw in JSON, line terminators in older JS) are safer
// escaped explicitly.
function toTsString(s) {
  return JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

const assets = {}
for (const [name, src] of Object.entries(SOURCES)) {
  assets[name] = escapeForInlineHtml(await fetchAsset(name, src))
  console.log(`fetched ${name}: ${assets[name].length} chars from ${src.url}`)
}

const header = `// GENERATED FILE — do not edit by hand. Regenerate with: node scripts/vendor-xterm.mjs
//
// Vendored xterm.js assets, inlined so the console terminal needs no CDN access
// at runtime. '</script'/'</style' sequences are pre-escaped to '<\\/...' so the
// payloads are safe to embed in HTML <script>/<style> tags.
//
// Sources (pinned):
//   XTERM_JS:     ${SOURCES.XTERM_JS.url}
//   XTERM_CSS:    ${SOURCES.XTERM_CSS.url}
//   ADDON_FIT_JS: ${SOURCES.ADDON_FIT_JS.url}
`

const out =
  header +
  `export const XTERM_JS = ${toTsString(assets.XTERM_JS)}\n` +
  `export const XTERM_CSS = ${toTsString(assets.XTERM_CSS)}\n` +
  `export const ADDON_FIT_JS = ${toTsString(assets.ADDON_FIT_JS)}\n`

const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'console', 'xterm-assets.ts')
writeFileSync(dest, out)
console.log(`wrote ${dest} (${out.length} bytes)`)
