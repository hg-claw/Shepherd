# Mobile app — R4: remote terminal — Design

**Date:** 2026-06-05
**Status:** Approved (approach confirmed via Q&A)
**Initiative:** Expo mobile app for Shepherd (`mobile/`). Roadmap: R1 token-auth ✅
(v0.23.0) → R2 skeleton+login ✅ (v0.24.0) → R3 list+monitoring ✅ (v0.25.0) →
**R4 remote terminal (this spec)** → R5 files+scripts → R6 plugins+push.

## Goal

Attach an interactive terminal in the app to a managed machine via Shepherd's
console PTY WebSocket — the headline "remote-control to a machine." A real
terminal (ANSI/colors/cursor/TUIs) via xterm.js running inside a WebView, with the
WebSocket and input handled in React Native so the bearer header + binary frames
work natively and the logic is unit-testable.

## Backend protocol (no backend change)

- `POST /api/admin/console/open {server_id, user, rows, cols, term}` (bearer) →
  `{session_id, sid}`.
- `GET /api/admin/console/ws?sid=<sid>` (bearer; `RequireAdmin`-gated, so R1's
  `Authorization: Bearer` header authenticates the upgrade) → WebSocket.
- **WS framing:** binary frames carry raw PTY bytes (output in / keystrokes out);
  text frames are JSON control — outgoing `{op:'resize',rows,cols}`, incoming
  `{op:'error',detail}` (e.g. unknown session). (Matches the web XtermPane.)

## Confirmed decisions

- **xterm.js in a WebView (display only)** via `react-native-webview`. The WS and
  all input live in RN; the WebView purely renders PTY output and reports its fit
  size. **Consequence: the app now needs a dev build** (react-native-webview is a
  native module, not in Expo Go). CI is unaffected (it only typechecks/lints/tests).
- **xterm.js loaded from a CDN** inside the WebView HTML (a remote-control tool
  already requires network to reach the server; no offline goal).
- **Input via a hidden RN `TextInput`** (the reliable mobile pattern) + an
  on-screen control-key bar — not WebView keyboard focus.
- **Manual reconnect** (a dead PTY can't be resumed; "Reconnect" reopens a fresh
  session).

## Headless-verification limit (explicit)

No simulator and no WebView runtime here. I unit-test everything in RN — the
console API call, the `ConsoleSession` WS client, the RN↔WebView bridge codec, and
the control-key byte mapping. **The actual xterm rendering + soft-keyboard
interaction inside the WebView is NOT verifiable headlessly** — the user verifies
it on a device via a dev build after the PR.

---

## Components

### 1. `src/api/console.ts`
```ts
export type ConsoleSessionInfo = { session_id: number; sid: string }
// openConsole POSTs /api/admin/console/open via authedFetch and returns the sid.
export function openConsole(serverId: number, rows: number, cols: number): Promise<ConsoleSessionInfo>
```
Body: `{ server_id, user: '', rows, cols, term: 'xterm-256color' }`.

### 2. `src/console/wsurl.ts`
```ts
// consoleWSURL turns the https baseURL + sid into the wss console URL.
export function consoleWSURL(baseURL: string, sid: string): string  // http→ws, https→wss, + /api/admin/console/ws?sid=
```

### 3. `src/console/session.ts` — `ConsoleSession`
A small class wrapping the WebSocket (testable with a fake `WebSocket`):
```ts
type Status = 'connecting' | 'open' | 'closed' | 'error'
type Handlers = {
  onData?: (bytes: Uint8Array) => void          // PTY output (binary frame)
  onControl?: (msg: { op: string; detail?: string }) => void  // JSON control frame
  onStatus?: (s: Status) => void
}
class ConsoleSession {
  constructor(baseURL: string, token: string | null, sid: string, rows: number, cols: number, h: Handlers)
  // opens new WebSocket(url, undefined, { headers: { Authorization: 'Bearer <token>' } }),
  // binaryType='arraybuffer'; on open → status 'open' + send {op:'resize',rows,cols};
  // onmessage: ArrayBuffer → onData(Uint8Array); string → JSON.parse → onControl;
  // onerror → status 'error'; onclose → status 'closed'.
  write(bytes: Uint8Array): void                // send binary keystrokes if open
  resize(rows: number, cols: number): void      // send {op:'resize',...}
  close(): void
}
```
A WS that can't set headers in some RN runtimes still works because RN's native
WebSocket supports the `{headers}` option (iOS/Android). The session never logs the
token.

### 4. `src/console/bridge.ts` — RN ↔ WebView message codec (pure)
`postMessage` is string-only, so PTY bytes are base64-framed.
```ts
// RN → WebView
export function dataMsg(bytes: Uint8Array): string   // JSON {type:'data', b64}
export function fitMsg(): string                     // JSON {type:'fit'}
// WebView → RN (parse the WebView's postMessage payloads)
export type FromWebView =
  | { type: 'input'; bytes: Uint8Array }   // decoded from {type:'input', b64}
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'ready' }
export function parseFromWebView(raw: string): FromWebView | null
export function b64encode(bytes: Uint8Array): string
export function b64decode(b64: string): Uint8Array
```
(base64 helpers are RN-safe — no `Buffer`/`atob` dependency assumptions; implement
with a small lookup or `global.btoa`/`atob` which Hermes provides.)

### 5. `src/console/terminal-html.ts`
Exports `TERMINAL_HTML: string` — a self-contained HTML document that:
- loads xterm.js + the fit addon from a CDN (`@xterm/xterm`),
- creates a `Terminal`, opens it full-screen, fits it,
- on `document` message (RN `injectJavaScript`/`postMessage`): `{type:'data'}` →
  `term.write(atob→bytes)`; `{type:'fit'}` → fit + post `{type:'resize',rows,cols}`,
- `term.onData(d)` → post `{type:'input', b64}`,
- on load → post `{type:'ready'}` then an initial `{type:'resize'}`.
Kept as a string constant so the plan can assert its message-protocol shape in a
jest test (a smoke check that the HTML contains the expected handlers), even though
the rendering itself isn't executed.

### 6. `app/(app)/server/[id]/console.tsx` — the terminal screen
Reached from the server detail screen ("Open console"). Flow:
1. `openConsole(id, rows, cols)` → sid (initial rows/cols are placeholders; the
   WebView's `fit` reports the real size which `resize()` sends).
2. Create a `ConsoleSession`; pipe `onData` → `webviewRef.injectJavaScript(dataMsg)`,
   `onStatus` → a status banner.
3. `<WebView source={{ html: TERMINAL_HTML }} onMessage={e => handle(parseFromWebView(e.nativeEvent.data))}>`:
   `input` → `session.write(bytes)`; `resize` → `session.resize(rows,cols)`;
   `ready` → start piping.
4. A **hidden `TextInput`** (auto-focus, autoCorrect/autoCapitalize off): each
   character/Enter(`\r`)/Backspace(`\x7f`) → `session.write` its bytes; clears
   after each so it streams raw keys. Tapping the terminal refocuses it (raises the
   soft keyboard).
5. A **control-key bar** (Esc/Tab/Ctrl-C/Ctrl-D/Ctrl-Z/↑↓←→/`|`/`/`/`~`/`-`) →
   `session.write(keymap[...])`.
6. Header: status (connecting/connected/closed) + **Reconnect** (re-runs
   `openConsole` + new session) + **Close** (`session.close()` + `router.back()`).

### 7. `src/console/keys.ts` — control-key byte map (pure)
```ts
export const KEYS: Record<string, Uint8Array>  // esc \x1b, tab \x09, ctrlC \x03, ctrlD \x04, ctrlZ \x1a, up \x1b[A, ...
export function charBytes(s: string): Uint8Array  // utf-8 encode a typed character/string
```

---

## Data flow
```
detail "Open console" → openConsole(id) → {sid}
ConsoleSession(baseURL, token, sid) --wss bearer-->  PTY
  PTY out (binary) → onData → injectJavaScript(dataMsg) → WebView xterm.write
  WebView onData → postMessage {input} → parseFromWebView → session.write → PTY
  WebView fit → postMessage {resize} → session.resize → {op:'resize'} → PTY
hidden TextInput / key bar → session.write(bytes) → PTY
401 / error control → status banner; Reconnect reopens
```

## Testing (jest, headless)
- **`openConsole`** (mock authedFetch): posts the right body, returns sid.
- **`consoleWSURL`**: https→wss, http→ws, sid encoded.
- **`ConsoleSession`** (fake global `WebSocket`): on open sends `{op:'resize'}` +
  status 'open'; incoming ArrayBuffer → `onData(Uint8Array)`; incoming string →
  `onControl(parsed)`; `write` sends the bytes when open (no-op when not);
  `resize` sends `{op:'resize'}`; `close` closes; error/close → status.
- **`bridge`**: `b64encode/decode` round-trip arbitrary bytes; `dataMsg`/`fitMsg`
  shapes; `parseFromWebView` decodes `input`/`resize`/`ready` and returns null on
  garbage.
- **`keys`**: each control key maps to the right bytes; `charBytes('a')` = `[0x61]`.
- **`terminal-html`**: the HTML string contains the expected message handlers
  (`'type'`/`'data'`/`'input'`/`'resize'`/`onData`) — a smoke assertion only.
- **console screen** (mock `WebView` as a stub, mock `openConsole` + session): the
  screen mounts, calls `openConsole`, and a control-bar press calls `session.write`
  (inject the session via a testable seam, e.g. a factory prop / module mock).

## Out of scope
- Session persistence / multiple tabs / background keep-alive; auto-reconnect; file
  transfer & SFTP (R5); copy-paste selection polish; terminal themes/settings.
- An Expo Go path (the WebView dep requires a dev build — documented, not worked
  around).

## Verification gates
`cd mobile && npx tsc --noEmit && npx eslint . && npx jest` green; the lock stays
in sync (CI `npm ci`); backend + web untouched. **Manual (user):** build a dev
client (`npx expo run:ios`/`run:android` or an EAS dev build), open a server's
console, run `ls`/`htop`/`vim`, confirm colors + the control-key bar + reconnect.
