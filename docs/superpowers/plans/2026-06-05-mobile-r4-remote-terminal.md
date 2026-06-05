# Mobile R4 — Remote Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An interactive terminal in the app attached to a machine's console PTY WebSocket — xterm.js rendered in a WebView, with the WebSocket + input handled in React Native.

**Architecture:** RN owns the bearer WS (`ConsoleSession`) and input (hidden TextInput + control-key bar); the WebView is a display-only xterm. A base64 `bridge` codec moves PTY bytes between RN and the WebView. All RN logic is unit-tested; the WebView render is verified on-device by the user.

**Tech Stack:** Expo SDK 56 + expo-router, react-native-webview (added here → app now needs a dev build), zustand/TanStack (prior rounds), jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-05-mobile-r4-remote-terminal-design.md`

**CRITICAL (R2 lesson):** any `npm install` in `mobile/` → commit the in-sync `package-lock.json` (CI `npm ci`). T1 + T9 verify `npm ci`.

**Headless:** verify only with `cd mobile && npx tsc --noEmit && npx eslint . && npx jest`. The WebView render/soft-keyboard is NOT verifiable here.

---

## File Structure
- `mobile/src/api/console.ts` (T2), `mobile/src/console/{wsurl.ts, session.ts, bridge.ts, keys.ts, terminal-html.ts}` (T2–T6), `mobile/src/app/(app)/console/[id].tsx` (T7), detail entry (T8).

---

## Task 1: Add react-native-webview (sync lock)

- [ ] **Step 1: Install + sync + verify**
```bash
cd /Users/hg/project/Shepherd/mobile
npx expo install react-native-webview
npm install --package-lock-only
rm -rf node_modules && npm ci
```
Expected: `npm ci` exit 0. Re-run `npm install` then `npm ci` until in sync.

- [ ] **Step 2: tsc/jest still green**
Run: `cd mobile && npx tsc --noEmit && npx jest --ci`
Expected: clean; all prior suites pass.

- [ ] **Step 3: Commit**
```bash
cd /Users/hg/project/Shepherd
git add mobile/package.json mobile/package-lock.json
git commit -m "feat(mobile): add react-native-webview (terminal needs a dev build)"
```
Confirm lock staged, node_modules not. Report the installed version.

---

## Task 2: console API client + wsurl

**Files:** Create `mobile/src/api/console.ts`, `mobile/src/console/wsurl.ts`; Tests alongside.

- [ ] **Step 1: Failing tests**

`mobile/src/api/__tests__/console.test.ts`:
```ts
import { openConsole } from '../console'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

test('openConsole posts the right body + returns sid', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ session_id: 5, sid: 'abc' })
  const r = await openConsole(7, 24, 80)
  expect(r.sid).toBe('abc')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/console/open', {
    method: 'POST',
    body: { server_id: 7, user: '', rows: 24, cols: 80, term: 'xterm-256color' },
  })
})
```
`mobile/src/console/__tests__/wsurl.test.ts`:
```ts
import { consoleWSURL } from '../wsurl'
test('https→wss + sid encoded', () => {
  expect(consoleWSURL('https://h.example', 'a b')).toBe('wss://h.example/api/admin/console/ws?sid=a%20b')
})
test('http→ws', () => {
  expect(consoleWSURL('http://h:8080', 'x')).toBe('ws://h:8080/api/admin/console/ws?sid=x')
})
```
Run `npx jest src/api/__tests__/console src/console/__tests__/wsurl` → FAIL.

- [ ] **Step 2: Implement**

`mobile/src/api/console.ts`:
```ts
import { authedFetch } from './authed'

export type ConsoleSessionInfo = { session_id: number; sid: string }

export function openConsole(serverId: number, rows: number, cols: number): Promise<ConsoleSessionInfo> {
  return authedFetch<ConsoleSessionInfo>('/api/admin/console/open', {
    method: 'POST',
    body: { server_id: serverId, user: '', rows, cols, term: 'xterm-256color' },
  })
}
```
`mobile/src/console/wsurl.ts`:
```ts
export function consoleWSURL(baseURL: string, sid: string): string {
  const ws = baseURL.replace(/^http/, 'ws')
  return `${ws}/api/admin/console/ws?sid=${encodeURIComponent(sid)}`
}
```

- [ ] **Step 3: Verify + commit**
Run: `cd mobile && npx jest src/api/__tests__/console src/console/__tests__/wsurl && npx tsc --noEmit && npx eslint .` → PASS.
```bash
cd /Users/hg/project/Shepherd
git add mobile/src/api/console.ts mobile/src/console/wsurl.ts mobile/src/api/__tests__/console.test.ts mobile/src/console/__tests__/wsurl.test.ts
git commit -m "feat(mobile): openConsole API + consoleWSURL"
```

---

## Task 3: bridge codec (base64 + messages)

**Files:** Create `mobile/src/console/bridge.ts` + test.

- [ ] **Step 1: Failing test** `mobile/src/console/__tests__/bridge.test.ts`:
```ts
import { b64encode, b64decode, dataMsg, fitMsg, parseFromWebView } from '../bridge'

test('base64 round-trips arbitrary bytes', () => {
  const bytes = new Uint8Array([0, 27, 91, 65, 255, 10])
  expect(b64decode(b64encode(bytes))).toEqual(bytes)
})
test('dataMsg/fitMsg shapes', () => {
  expect(JSON.parse(dataMsg(new Uint8Array([65]))).type).toBe('data')
  expect(JSON.parse(fitMsg()).type).toBe('fit')
})
test('parseFromWebView decodes input/resize/ready, null on garbage', () => {
  const i = parseFromWebView(JSON.stringify({ type: 'input', b64: b64encode(new Uint8Array([97])) }))
  expect(i).toEqual({ type: 'input', bytes: new Uint8Array([97]) })
  expect(parseFromWebView(JSON.stringify({ type: 'resize', rows: 24, cols: 80 }))).toEqual({ type: 'resize', rows: 24, cols: 80 })
  expect(parseFromWebView(JSON.stringify({ type: 'ready' }))).toEqual({ type: 'ready' })
  expect(parseFromWebView('not json')).toBeNull()
  expect(parseFromWebView(JSON.stringify({ type: 'nope' }))).toBeNull()
})
```
Run `npx jest src/console/__tests__/bridge` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/console/bridge.ts`:
```ts
export function b64encode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return globalThis.btoa(bin)
}
export function b64decode(b64: string): Uint8Array {
  const bin = globalThis.atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function dataMsg(bytes: Uint8Array): string {
  return JSON.stringify({ type: 'data', b64: b64encode(bytes) })
}
export function fitMsg(): string {
  return JSON.stringify({ type: 'fit' })
}

export type FromWebView =
  | { type: 'input'; bytes: Uint8Array }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'ready' }

export function parseFromWebView(raw: string): FromWebView | null {
  let m: unknown
  try { m = JSON.parse(raw) } catch { return null }
  if (typeof m !== 'object' || m === null) return null
  const o = m as Record<string, unknown>
  if (o.type === 'input' && typeof o.b64 === 'string') return { type: 'input', bytes: b64decode(o.b64) }
  if (o.type === 'resize' && typeof o.rows === 'number' && typeof o.cols === 'number') return { type: 'resize', rows: o.rows, cols: o.cols }
  if (o.type === 'ready') return { type: 'ready' }
  return null
}
```

- [ ] **Step 3: Verify + commit**
Run: `cd mobile && npx jest src/console/__tests__/bridge && npx tsc --noEmit && npx eslint .` → PASS.
```bash
cd /Users/hg/project/Shepherd
git add mobile/src/console/bridge.ts mobile/src/console/__tests__/bridge.test.ts
git commit -m "feat(mobile): RN<->WebView terminal bridge codec (base64)"
```

---

## Task 4: control-key map

**Files:** Create `mobile/src/console/keys.ts` + test.

- [ ] **Step 1: Failing test** `mobile/src/console/__tests__/keys.test.ts`:
```ts
import { KEYS, charBytes } from '../keys'
test('control keys', () => {
  expect(Array.from(KEYS.esc)).toEqual([0x1b])
  expect(Array.from(KEYS.ctrlC)).toEqual([0x03])
  expect(Array.from(KEYS.up)).toEqual([0x1b, 0x5b, 0x41])
  expect(Array.from(KEYS.tab)).toEqual([0x09])
})
test('charBytes utf-8', () => {
  expect(Array.from(charBytes('a'))).toEqual([0x61])
  expect(Array.from(charBytes('\r'))).toEqual([0x0d])
})
```
Run `npx jest src/console/__tests__/keys` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/console/keys.ts`:
```ts
const enc = (...n: number[]) => new Uint8Array(n)

export const KEYS: Record<string, Uint8Array> = {
  esc: enc(0x1b),
  tab: enc(0x09),
  ctrlC: enc(0x03),
  ctrlD: enc(0x04),
  ctrlZ: enc(0x1a),
  up: enc(0x1b, 0x5b, 0x41),
  down: enc(0x1b, 0x5b, 0x42),
  right: enc(0x1b, 0x5b, 0x43),
  left: enc(0x1b, 0x5b, 0x44),
  enter: enc(0x0d),
  backspace: enc(0x7f),
}

export function charBytes(s: string): Uint8Array {
  // UTF-8 encode without TextEncoder (not always present in RN): use the
  // standard encodeURIComponent trick for portability.
  const utf8 = unescape(encodeURIComponent(s))
  const out = new Uint8Array(utf8.length)
  for (let i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i)
  return out
}
```

- [ ] **Step 3: Verify + commit**
Run: `cd mobile && npx jest src/console/__tests__/keys && npx tsc --noEmit && npx eslint .` → PASS.
```bash
cd /Users/hg/project/Shepherd
git add mobile/src/console/keys.ts mobile/src/console/__tests__/keys.test.ts
git commit -m "feat(mobile): terminal control-key byte map"
```

---

## Task 5: ConsoleSession WS client

**Files:** Create `mobile/src/console/session.ts` + test.

- [ ] **Step 1: Failing test** `mobile/src/console/__tests__/session.test.ts`:
```ts
import { ConsoleSession } from '../session'

class FakeWS {
  static last: FakeWS
  url: string; opts: any; binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: unknown[] = []
  readyState = 0
  constructor(url: string, _p: unknown, opts: unknown) { this.url = url; this.opts = opts; FakeWS.last = this }
  send(d: unknown) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.() }
}
;(global as any).WebSocket = FakeWS

test('opens with bearer header, sends resize on open, routes frames', () => {
  const data: Uint8Array[] = []
  const control: any[] = []
  const status: string[] = []
  const s = new ConsoleSession('https://h', 'TKN', 'sid1', 24, 80, {
    onData: (b) => data.push(b), onControl: (m) => control.push(m), onStatus: (st) => status.push(st),
  })
  const ws = FakeWS.last
  expect(ws.url).toBe('wss://h/api/admin/console/ws?sid=sid1')
  expect(ws.opts.headers.Authorization).toBe('Bearer TKN')
  expect(ws.binaryType).toBe('arraybuffer')

  ws.readyState = 1
  ws.onopen!()
  expect(status).toContain('open')
  expect(JSON.parse(ws.sent[0] as string)).toEqual({ op: 'resize', rows: 24, cols: 80 })

  ws.onmessage!({ data: new Uint8Array([65, 66]).buffer })
  expect(Array.from(data[0])).toEqual([65, 66])
  ws.onmessage!({ data: JSON.stringify({ op: 'error', detail: 'x' }) })
  expect(control[0]).toEqual({ op: 'error', detail: 'x' })

  s.write(new Uint8Array([9]))
  expect(ws.sent[ws.sent.length - 1]).toBeInstanceOf(Uint8Array)
  s.resize(30, 100)
  expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({ op: 'resize', rows: 30, cols: 100 })

  s.close()
  expect(status).toContain('closed')
})
```
Run `npx jest src/console/__tests__/session` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/console/session.ts`:
```ts
import { consoleWSURL } from './wsurl'

export type ConsoleStatus = 'connecting' | 'open' | 'closed' | 'error'
export type ConsoleHandlers = {
  onData?: (bytes: Uint8Array) => void
  onControl?: (msg: { op: string; detail?: string }) => void
  onStatus?: (s: ConsoleStatus) => void
}

export class ConsoleSession {
  private ws: WebSocket
  private rows: number
  private cols: number

  constructor(baseURL: string, token: string | null, sid: string, rows: number, cols: number, private h: ConsoleHandlers) {
    this.rows = rows
    this.cols = cols
    const url = consoleWSURL(baseURL, sid)
    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
    // RN WebSocket accepts (url, protocols, options); options carries headers.
    this.ws = new WebSocket(url, undefined as unknown as string[], opts as unknown as undefined)
    this.ws.binaryType = 'arraybuffer'
    this.h.onStatus?.('connecting')
    this.ws.onopen = () => {
      this.h.onStatus?.('open')
      this.resize(this.rows, this.cols)
    }
    this.ws.onmessage = (e: { data: unknown }) => {
      if (typeof e.data === 'string') {
        try { this.h.onControl?.(JSON.parse(e.data)) } catch { /* ignore */ }
      } else {
        this.h.onData?.(new Uint8Array(e.data as ArrayBuffer))
      }
    }
    this.ws.onerror = () => this.h.onStatus?.('error')
    this.ws.onclose = () => this.h.onStatus?.('closed')
  }

  write(bytes: Uint8Array): void {
    if (this.ws.readyState === 1) this.ws.send(bytes)
  }
  resize(rows: number, cols: number): void {
    this.rows = rows
    this.cols = cols
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: 'resize', rows, cols }))
  }
  close(): void {
    this.ws.close()
  }
}
```

- [ ] **Step 3: Verify + commit**
Run: `cd mobile && npx jest src/console/__tests__/session && npx tsc --noEmit && npx eslint .` → PASS.
```bash
cd /Users/hg/project/Shepherd
git add mobile/src/console/session.ts mobile/src/console/__tests__/session.test.ts
git commit -m "feat(mobile): ConsoleSession (bearer WS, resize-on-open, frame routing)"
```

---

## Task 6: terminal HTML (xterm via CDN)

**Files:** Create `mobile/src/console/terminal-html.ts` + smoke test.

- [ ] **Step 1: Failing smoke test** `mobile/src/console/__tests__/terminal-html.test.ts`:
```ts
import { TERMINAL_HTML } from '../terminal-html'
test('HTML wires the message protocol', () => {
  expect(TERMINAL_HTML).toContain('@xterm/xterm')
  expect(TERMINAL_HTML).toContain("'data'")
  expect(TERMINAL_HTML).toContain("'input'")
  expect(TERMINAL_HTML).toContain("'resize'")
  expect(TERMINAL_HTML).toContain('onData')
  expect(TERMINAL_HTML).toContain('ReactNativeWebView')
})
```
Run `npx jest src/console/__tests__/terminal-html` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/console/terminal-html.ts`:
```ts
// TERMINAL_HTML is a self-contained xterm.js host. RN drives it via document
// 'message' events ({type:'data'|'fit'}) and receives postMessage payloads
// ({type:'input'|'resize'|'ready'}). xterm is loaded from a CDN (the app needs
// network to reach the server anyway).
export const TERMINAL_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<style>html,body,#t{height:100%;width:100%;margin:0;background:#0a0a0b}</style></head>
<body><div id="t"></div><script>
var post=function(o){window.ReactNativeWebView.postMessage(JSON.stringify(o))};
var term=new window.Terminal({fontSize:13,convertEol:false,theme:{background:'#0a0a0b'}});
var fit=new window.FitAddon.FitAddon();term.loadAddon(fit);
term.open(document.getElementById('t'));
function doFit(){try{fit.fit();post({type:'resize',rows:term.rows,cols:term.cols})}catch(e){}}
term.onData(function(d){
  var b=[];for(var i=0;i<d.length;i++)b.push(d.charCodeAt(i)&255);
  post({type:'input',b64:btoa(String.fromCharCode.apply(null,b))});
});
function onMsg(ev){
  var m;try{m=JSON.parse(ev.data)}catch(e){return}
  if(m.type==='data'){var s=atob(m.b64);term.write(s)}
  else if(m.type==='fit'){doFit()}
}
document.addEventListener('message',onMsg);window.addEventListener('message',onMsg);
window.addEventListener('resize',doFit);
setTimeout(function(){doFit();post({type:'ready'})},50);
</script></body></html>`
```
(Note: `term.write(atob(...))` writes a Latin-1 string of the raw bytes — xterm
decodes the byte stream; this matches how the web pane writes `Uint8Array`.)

- [ ] **Step 3: Verify + commit**
Run: `cd mobile && npx jest src/console/__tests__/terminal-html && npx tsc --noEmit && npx eslint .` → PASS.
```bash
cd /Users/hg/project/Shepherd
git add mobile/src/console/terminal-html.ts mobile/src/console/__tests__/terminal-html.test.ts
git commit -m "feat(mobile): xterm.js WebView host HTML (CDN)"
```

---

## Task 7: Terminal screen

**Files:** Create `mobile/src/app/(app)/console/[id].tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/console/__tests__/console.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import ConsoleScreen from '../[id]'

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }), useRouter: () => ({ back: jest.fn() }) }))
jest.mock('react-native-webview', () => ({ WebView: () => null }))
jest.mock('@/api/console', () => ({ openConsole: jest.fn().mockResolvedValue({ session_id: 1, sid: 's1' }) }))
jest.mock('@/store/auth', () => ({ useAuth: Object.assign((sel: any) => sel({ baseURL: 'https://h', token: 'T' }), { getState: () => ({ baseURL: 'https://h', token: 'T' }) }) }))

const writeMock = jest.fn()
jest.mock('@/console/session', () => ({
  ConsoleSession: jest.fn().mockImplementation(() => ({ write: writeMock, resize: jest.fn(), close: jest.fn() })),
}))
import { openConsole } from '@/api/console'

beforeEach(() => writeMock.mockReset())

test('opens console on mount and a control key writes bytes', async () => {
  const { getByText } = render(<ConsoleScreen />)
  await waitFor(() => expect(openConsole).toHaveBeenCalledWith(7, expect.any(Number), expect.any(Number)))
  fireEvent.press(getByText('Esc'))
  expect(writeMock).toHaveBeenCalled()
  expect(Array.from(writeMock.mock.calls[0][0])).toEqual([0x1b])
})
```
Run `npx jest "src/app/(app)/console/__tests__/console"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/console/[id].tsx`:
```tsx
import { useEffect, useRef, useState } from 'react'
import { View, Text, Pressable, TextInput, ScrollView } from 'react-native'
import { WebView } from 'react-native-webview'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { openConsole } from '@/api/console'
import { ConsoleSession, type ConsoleStatus } from '@/console/session'
import { TERMINAL_HTML } from '@/console/terminal-html'
import { dataMsg, parseFromWebView } from '@/console/bridge'
import { KEYS, charBytes } from '@/console/keys'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

const BAR: { label: string; bytes: Uint8Array }[] = [
  { label: 'Esc', bytes: KEYS.esc }, { label: 'Tab', bytes: KEYS.tab },
  { label: '^C', bytes: KEYS.ctrlC }, { label: '^D', bytes: KEYS.ctrlD }, { label: '^Z', bytes: KEYS.ctrlZ },
  { label: '↑', bytes: KEYS.up }, { label: '↓', bytes: KEYS.down }, { label: '←', bytes: KEYS.left }, { label: '→', bytes: KEYS.right },
]

export default function ConsoleScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const baseURL = useAuth((s) => s.baseURL)
  const token = useAuth((s) => s.token)
  const webRef = useRef<WebView>(null)
  const sessionRef = useRef<ConsoleSession | null>(null)
  const [status, setStatus] = useState<ConsoleStatus>('connecting')

  const start = async () => {
    setStatus('connecting')
    const { sid } = await openConsole(Number(id), 24, 80)
    sessionRef.current = new ConsoleSession(baseURL ?? '', token, sid, 24, 80, {
      onData: (bytes) => webRef.current?.injectJavaScript(`(function(){var ev={data:${JSON.stringify(dataMsg(bytes))}};(window.dispatchEvent||function(){})(new MessageEvent('message',ev));})();true;`),
      onStatus: setStatus,
    })
  }
  useEffect(() => { start() /* eslint-disable-next-line react-hooks/exhaustive-deps */; return () => sessionRef.current?.close() }, [])

  const onMessage = (raw: string) => {
    const m = parseFromWebView(raw)
    if (!m) return
    if (m.type === 'input') sessionRef.current?.write(m.bytes)
    else if (m.type === 'resize') sessionRef.current?.resize(m.rows, m.cols)
  }
  const sendKey = (bytes: Uint8Array) => sessionRef.current?.write(bytes)

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, flex: 1 }}>Console · {status}</Text>
        <Pressable onPress={start} style={{ marginRight: theme.space(3) }}><Text style={{ color: theme.accent }}>Reconnect</Text></Pressable>
        <Pressable onPress={() => { sessionRef.current?.close(); router.back() }}><Text style={{ color: theme.textDim }}>Close</Text></Pressable>
      </View>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html: TERMINAL_HTML }}
        onMessage={(e) => onMessage(e.nativeEvent.data)}
        style={{ flex: 1, backgroundColor: theme.bg }}
      />
      <TextInput
        autoFocus autoCorrect={false} autoCapitalize="none" spellCheck={false} blurOnSubmit={false}
        value=""
        onChangeText={(t) => { if (t) sendKey(charBytes(t)) }}
        onKeyPress={(e) => { if (e.nativeEvent.key === 'Backspace') sendKey(KEYS.backspace); else if (e.nativeEvent.key === 'Enter') sendKey(KEYS.enter) }}
        style={{ height: 1, opacity: 0 }}
      />
      <ScrollView horizontal keyboardShouldPersistTaps="always" style={{ maxHeight: 44, borderTopWidth: 1, borderColor: theme.border }} contentContainerStyle={{ alignItems: 'center', padding: theme.space(1) }}>
        {BAR.map((k) => (
          <Pressable key={k.label} onPress={() => sendKey(k.bytes)} style={{ paddingHorizontal: theme.space(3), paddingVertical: theme.space(2), marginHorizontal: theme.space(1), borderRadius: 6, backgroundColor: theme.surface }}>
            <Text style={{ color: theme.text, fontFamily: 'monospace' }}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  )
}
```
(If `injectJavaScript`-based delivery is awkward in the test, the test mocks WebView
to a no-op and only asserts openConsole + control-key writes — adapt the data-push
mechanism if needed, but keep `onMessage` routing input→`session.write` and resize→
`session.resize`.)

- [ ] **Step 3: Verify + commit**
Run: `cd mobile && npx jest "src/app/(app)/console/__tests__/console" && npx tsc --noEmit && npx eslint .` → PASS. Then full `npx jest`.
```bash
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/console/"
git commit -m "feat(mobile): terminal screen (xterm WebView + input + control bar + reconnect)"
```

---

## Task 8: "Open console" entry from detail

**Files:** Modify `mobile/src/app/(app)/server/[id].tsx`.

- [ ] **Step 1: Add the button**
In the detail screen, import `useRouter` from `expo-router` and add (below the metrics, before the closing `</View>`):
```tsx
      <Pressable onPress={() => router.push(`/(app)/console/${row.id}`)} style={{ marginTop: theme.space(5), padding: theme.space(3), borderRadius: 8, backgroundColor: theme.accent, alignItems: 'center' }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Open console</Text>
      </Pressable>
```
Add `const router = useRouter()` near the top of the component and `Pressable` to the `react-native` import.

- [ ] **Step 2: Verify + commit**
Run: `cd mobile && npx tsc --noEmit && npx jest "src/app/(app)/server/__tests__/detail" && npx eslint .` → PASS (the detail test still renders; the new button doesn't break it). If the detail test asserts exact children, it still passes (it checks for the name + os text).
```bash
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/server/[id].tsx"
git commit -m "feat(mobile): 'Open console' entry on server detail"
```

---

## Task 9: Full verification

- [ ] **Step 1: Mobile gates (clean install — CI parity)**
Run: `cd /Users/hg/project/Shepherd/mobile && rm -rf node_modules && npm ci && npx tsc --noEmit && npx eslint . && npx jest --ci`
Expected: `npm ci` exit 0; tsc clean; eslint no errors; all suites pass.

- [ ] **Step 2: Backend/web untouched + hygiene**
Run: `cd /Users/hg/project/Shepherd && go build ./... && git status --porcelain | grep -i node_modules && echo LEAK || echo clean`
Expected: build OK; "clean".

---

## Self-Review
- **Spec coverage:** react-native-webview dep → T1; openConsole + wsurl → T2; bridge → T3; keys → T4; ConsoleSession → T5; terminal HTML → T6; terminal screen (WebView + hidden TextInput + control bar + reconnect/close) → T7; detail entry → T8; gates → T9. All spec components mapped.
- **Type consistency:** `openConsole(serverId,rows,cols)→{sid}` (T2) used in the screen (T7); `consoleWSURL` (T2) used by `ConsoleSession` (T5); `ConsoleSession(baseURL,token,sid,rows,cols,handlers)` + `write/resize/close` (T5) used in the screen; `dataMsg/parseFromWebView/b64*` (T3) used in the screen; `KEYS/charBytes` (T4) used in the bar + TextInput.
- **Placeholders:** none — complete code + tests. The WebView render + soft-keyboard remain device-only (documented); the data-push mechanism in T7 is noted as adaptable while keeping the testable contract (openConsole on mount, control-key→write, onMessage→write/resize).
- **Risk note:** R2's stale-lock CI failure is pre-empted (T1+T9 verify `npm ci`). The screen test mocks `react-native-webview` + `@/console/session`, so it needs no WebView runtime. `term.write` of a Latin-1 byte-string matches the web pane's Uint8Array write.
