import { TERMINAL_HTML } from '../terminal-html'
test('HTML wires the message protocol', () => {
  expect(TERMINAL_HTML).toContain('@xterm/xterm')
  expect(TERMINAL_HTML).toContain("'data'")
  expect(TERMINAL_HTML).toContain("'input'")
  expect(TERMINAL_HTML).toContain("'resize'")
  expect(TERMINAL_HTML).toContain('onData')
  expect(TERMINAL_HTML).toContain('ReactNativeWebView')
  expect(TERMINAL_HTML).toContain('__shepCopy') // copy-to-clipboard hook
  expect(TERMINAL_HTML).toContain('getSelection')
})
