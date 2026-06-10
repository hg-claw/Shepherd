import { TERMINAL_HTML } from '../terminal-html'
import { XTERM_JS, XTERM_CSS, ADDON_FIT_JS } from '../xterm-assets'

test('HTML wires the message protocol', () => {
  expect(TERMINAL_HTML).toContain("'data'")
  expect(TERMINAL_HTML).toContain("'input'")
  expect(TERMINAL_HTML).toContain("'resize'")
  expect(TERMINAL_HTML).toContain("'ready'")
  expect(TERMINAL_HTML).toContain("'copy'")
  expect(TERMINAL_HTML).toContain('onData')
  expect(TERMINAL_HTML).toContain('ReactNativeWebView')
  expect(TERMINAL_HTML).toContain('__shepCopy') // copy-to-clipboard hook
  expect(TERMINAL_HTML).toContain('getSelection')
})

test('xterm is vendored: no CDN or external script/style references', () => {
  expect(TERMINAL_HTML).not.toContain('cdn.jsdelivr.net/npm')
  expect(TERMINAL_HTML).not.toMatch(/<script[^>]*\ssrc=/i)
  expect(TERMINAL_HTML).not.toMatch(/<link[^>]*\shref=/i)
})

test('vendored xterm payloads are inlined and plausible', () => {
  // xterm.min.js is ~280KB of minified UMD that registers window.Terminal.
  expect(XTERM_JS.length).toBeGreaterThan(200_000)
  expect(XTERM_JS).toContain('Terminal')
  expect(XTERM_CSS).toContain('.xterm')
  expect(ADDON_FIT_JS).toContain('FitAddon')
  expect(TERMINAL_HTML).toContain(XTERM_JS)
  expect(TERMINAL_HTML).toContain(XTERM_CSS)
  expect(TERMINAL_HTML).toContain(ADDON_FIT_JS)
})

test('inlined payloads do not break <script>/<style> tag structure', () => {
  // A literal '</script' inside a payload would terminate the surrounding tag
  // early (the generator escapes it to '<\/script'). Same for '</style'.
  for (const payload of [XTERM_JS, XTERM_CSS, ADDON_FIT_JS]) {
    expect(payload).not.toMatch(/<\/script/i)
    expect(payload).not.toMatch(/<\/style/i)
    expect(payload).not.toContain('<!--') // would enter HTML script-escaped state
  }
  // Every <script> opened in the final html is closed, and vice versa.
  const opens = TERMINAL_HTML.match(/<script\b/gi) ?? []
  const closes = TERMINAL_HTML.match(/<\/script>/gi) ?? []
  expect(opens.length).toBe(closes.length)
  expect(opens.length).toBe(3) // xterm + fit addon + bridge script
  const styleOpens = TERMINAL_HTML.match(/<style\b/gi) ?? []
  const styleCloses = TERMINAL_HTML.match(/<\/style>/gi) ?? []
  expect(styleOpens.length).toBe(styleCloses.length)
})
