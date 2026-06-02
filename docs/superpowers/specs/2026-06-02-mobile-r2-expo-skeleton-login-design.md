# Mobile app — R2: Expo skeleton + login — Design

**Date:** 2026-06-02
**Status:** Approved (scope + stack confirmed via Q&A)
**Initiative:** Expo mobile app for Shepherd (monorepo `mobile/`). Roadmap:
R1 bearer-token auth ✅ (v0.23.0) → **R2 skeleton + login (this spec)** → R3 server
list + monitoring → R4 remote terminal → R5 files + scripts → R6 plugins +
push/biometrics. Each round = its own spec → plan → PR → release.

## Goal

Stand up the Expo/React Native app in `mobile/` with a working login flow: enter a
server URL + admin credentials → `POST /api/login` (opt-in `client:"mobile"`) →
store the bearer token securely → land on a placeholder authenticated screen.
Establishes the foundation (navigation, auth store, typed API client, secure
storage, theme, CI) that R3+ build on.

## Headless constraint (critical)

This is built in a headless environment with **no iOS/Android simulator**.
Verification is limited to `tsc --noEmit` + `eslint` + `jest` (jest-expo +
@testing-library/react-native run under Node, no device). All meaningful logic
(API client, auth store, storage, login submit) is unit-tested; the spec
deliberately keeps native-only behaviour thin. Real device/simulator smoke-testing
(`npx expo start`) is the user's manual step after the PR.

## Confirmed stack

- **Expo (managed workflow) + TypeScript + expo-router** (file-based routing).
- **zustand** for auth state (mirrors the web app); **expo-secure-store** for the
  token, **@react-native-async-storage/async-storage** for the non-secret server
  URL.
- **jest** with the **jest-expo** preset + **@testing-library/react-native** for
  component tests; **eslint** (expo config).
- Managed workflow is sufficient for R2 (secure-store + fetch are available in
  Expo Go). R4's terminal may later need a dev build — out of scope here.

---

## Directory layout (`mobile/`)

```
mobile/
  package.json            Expo SDK, scripts (start/test/lint/typecheck)
  app.json                Expo config (name, slug, scheme "shepherd")
  tsconfig.json           extends expo/tsconfig.base, strict
  babel.config.js         babel-preset-expo
  jest.config.js          preset jest-expo; setup file
  .eslintrc.js            eslint-config-expo
  jest-setup.ts           mocks for expo-secure-store + async-storage
  app/
    _layout.tsx           root: restore() on mount; redirect by auth state
    (auth)/_layout.tsx    stack for unauthenticated
    (auth)/login.tsx      login screen
    (app)/_layout.tsx     stack for authenticated
    (app)/index.tsx       placeholder Home ("Connected to <url> as <admin>")
  src/
    store/auth.ts         zustand auth store
    api/client.ts         apiFetch(baseURL, token, path, opts)
    api/auth.ts           loginRequest()/logoutRequest()
    storage/secure.ts     token + baseURL persistence
    theme/index.ts        dark theme constants
  src/**/__tests__/       unit tests
```

---

## Components & interfaces

### `src/storage/secure.ts`
Thin persistence wrapper (so it's mockable + the only module touching native
storage):
```ts
export async function saveToken(token: string): Promise<void>   // SecureStore.setItemAsync
export async function loadToken(): Promise<string | null>
export async function clearToken(): Promise<void>
export async function saveBaseURL(url: string): Promise<void>   // AsyncStorage
export async function loadBaseURL(): Promise<string | null>
```

### `src/api/client.ts`
One typed fetch wrapper — the ONLY place that attaches auth + normalizes errors:
```ts
export class APIError extends Error { constructor(public status: number, message: string) {...} }

// apiFetch builds `${baseURL}${path}`, sets Authorization: Bearer <token> (when
// token given) + JSON headers, parses the JSON body, and throws APIError on a
// non-2xx (using the server's {"error"} message when present). A 401 throws
// APIError(401, ...) — callers (the store) treat that as "session invalid".
export async function apiFetch<T>(
  baseURL: string, token: string | null, path: string, opts?: { method?: string; body?: unknown },
): Promise<T>
```

### `src/api/auth.ts`
```ts
export type LoginResult = { id: number; username: string; token: string }
// loginRequest POSTs /api/login with {username,password,client:"mobile"} and
// REQUIRES a token in the response (else throws — the server must be R1+).
export function loginRequest(baseURL: string, username: string, password: string): Promise<LoginResult>
export function logoutRequest(baseURL: string, token: string): Promise<void> // POST /api/logout (bearer)
```

### `src/store/auth.ts` (zustand)
```ts
type AuthState = {
  status: 'loading' | 'signedOut' | 'signedIn'
  baseURL: string | null
  token: string | null
  admin: { id: number; username: string } | null
  error: string | null
  restore: () => Promise<void>            // load token+baseURL from storage on launch
  login: (baseURL: string, username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearSession: () => void                // local-only wipe (used on 401)
}
```
- `restore`: load token + baseURL; if both present, `status='signedIn'` (R2 trusts
  the stored token; a `/api/admins/me` validation is an R3 nicety) else
  `'signedOut'`.
- `login`: call `loginRequest`, persist token + baseURL, set
  `status='signedIn'`, clear error; on `APIError` set `error` + stay signed out.
- `logout`: best-effort `logoutRequest`, then `clearToken()` + reset to signedOut.
- `clearSession`: synchronous local wipe (storage + state) — the API client's 401
  handler calls this so an invalid token bounces to login.

### Routing (`app/`)
- `app/_layout.tsx`: on mount call `restore()`; while `status==='loading'` render a
  splash/spinner; otherwise render the router. A redirect guard sends
  `signedOut → /(auth)/login` and `signedIn → /(app)`.
- `(auth)/login.tsx`: three inputs (server URL prefilled from stored baseURL or a
  sensible default, username, password), a submit button (disabled while
  submitting), and the store's `error` shown inline. Submit calls `login(...)`.
- `(app)/index.tsx`: placeholder showing "Connected to {baseURL} as {admin.username}"
  + a Logout button (calls `logout()`). R3 replaces this with the server list.

### `src/theme/index.ts`
A small dark palette + spacing constants matching the web's aesthetic (bg, surface,
text, accent, error). No theming library — plain constants for R2.

---

## Data flow

```
launch → store.restore() → token in SecureStore?
  yes → status=signedIn → (app)/index
  no  → status=signedOut → (auth)/login
login submit → loginRequest(baseURL,user,pass) → {token} → saveToken + saveBaseURL
  → status=signedIn → router → (app)
any apiFetch → Authorization: Bearer <token>; 401 → store.clearSession() → (auth)/login
logout → logoutRequest(bearer) → clearToken → signedOut → (auth)/login
```

---

## CI

Add a `mobile` job to `.github/workflows/ci.yml`, parallel to `web`:
```yaml
  mobile:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          cache: 'npm'
          cache-dependency-path: 'mobile/package-lock.json'
      - run: cd mobile && npm ci
      - run: cd mobile && npx tsc --noEmit
      - run: cd mobile && npx eslint .
      - run: cd mobile && npx jest --ci
```

---

## Testing (jest, headless)

- **`storage/secure`**: with mocked `expo-secure-store` + async-storage,
  save/load/clear round-trip; `loadToken` returns null when unset.
- **`api/client`** (mock global `fetch`): attaches `Authorization: Bearer <token>`
  when token present and omits it when null; parses JSON; throws `APIError` with
  the status + server `{"error"}` message on non-2xx; 401 surfaces as
  `APIError(401)`.
- **`api/auth`**: `loginRequest` posts `client:"mobile"` and returns the token;
  throws if the response lacks a token (server not R1+).
- **`store/auth`** (mock `api/*` + `storage/*`): `login` success → state signedIn
  + token persisted; `login` failure (APIError) → error set, stays signedOut;
  `restore` with a stored token → signedIn; `logout`/`clearSession` → signedOut +
  token cleared.
- **`(auth)/login` screen** (RNTL, mock store): renders the three fields; pressing
  submit calls `store.login` with the entered values; the store `error` renders.

`.gitignore`: add `mobile/node_modules/`, `mobile/.expo/`, `mobile/dist/`.

## Out of scope

- Server list / telemetry / terminal / files (R3–R5); push / biometrics (R6).
- Token-validity check against `/api/admins/me` on restore (R3 nicety).
- Deep links, offline cache, multi-server profiles, theming library.
- Producing a built binary / store submission.

## Verification gates

`cd mobile && npx tsc --noEmit && npx eslint . && npx jest` all green; the Go
backend + web app are untouched (their CI stays green). **Manual (user):**
`cd mobile && npx expo start`, open in Expo Go / simulator, log in against a running
Shepherd server, confirm the placeholder Home shows the admin + Logout works.
