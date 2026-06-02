# Mobile R2 — Expo Skeleton + Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Expo/TypeScript app in `mobile/` with a working login flow (server URL + creds → bearer token in SecureStore → authenticated placeholder screen), all verified headlessly via tsc/eslint/jest.

**Architecture:** expo-router app; a zustand auth store drives routing (signedOut→login, signedIn→app); a single typed `apiFetch` attaches the bearer token and normalizes errors (401→clearSession); `storage/secure.ts` is the only module touching native storage. Our logic modules are fully unit-tested; the native scaffold is established with `create-expo-app` and iterated to a green toolchain.

**Tech Stack:** Expo (managed) + TypeScript + expo-router, zustand, expo-secure-store, @react-native-async-storage/async-storage; jest (jest-expo) + @testing-library/react-native; eslint-config-expo.

**Spec:** `docs/superpowers/specs/2026-06-02-mobile-r2-expo-skeleton-login-design.md`

**Headless note:** no simulator. Every task verifies with `cd mobile && npx tsc --noEmit` / `npx jest` / `npx eslint .`. Device smoke-test is the user's manual step.

---

## File Structure
- `mobile/` — Expo app (Task 1 scaffolds; later tasks add `src/` + `app/`).
- `src/storage/secure.ts` (T2), `src/api/client.ts` (T3), `src/api/auth.ts` (T4), `src/store/auth.ts` (T5), `src/theme/index.ts` + `app/*` (T6).
- `.github/workflows/ci.yml` + root `.gitignore` (T7).

---

## Task 1: Scaffold Expo app + test toolchain (green baseline)

**Files:** create `mobile/` (Expo default template) + jest/test config.

This task is environment-sensitive — establish a GREEN baseline; adapt versions/config to what the tooling installs. Use a capable model.

- [ ] **Step 1: Scaffold the app**

From the repo root:
```bash
cd /Users/hg/project/Shepherd
npx create-expo-app@latest mobile --template default --no-install
cd mobile && npm install
```
The `default` template gives expo-router + TypeScript + a starter `app/`. If
`create-expo-app` prompts, pass flags to keep it non-interactive. Confirm
`mobile/package.json`, `mobile/app/`, `mobile/tsconfig.json` exist.

- [ ] **Step 2: Add runtime + dev deps (let Expo align versions)**

```bash
cd /Users/hg/project/Shepherd/mobile
npx expo install zustand expo-secure-store @react-native-async-storage/async-storage
npm install --save-dev jest jest-expo @testing-library/react-native @types/jest eslint eslint-config-expo
```
(`expo install` pins versions compatible with the installed SDK.)

- [ ] **Step 3: Configure jest + eslint + scripts**

Create `mobile/jest.config.js`:
```js
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest-setup.ts'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|expo-router|@react-native-async-storage/.*))',
  ],
}
```

Create `mobile/jest-setup.ts` (mocks the native modules so unit tests run under Node):
```ts
jest.mock('expo-secure-store', () => {
  const mem: Record<string, string> = {}
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => { mem[k] = v }),
    getItemAsync: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    deleteItemAsync: jest.fn(async (k: string) => { delete mem[k] }),
  }
})
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'))
```

Create `mobile/.eslintrc.js`:
```js
module.exports = { extends: 'expo', ignorePatterns: ['/dist', '/node_modules', '/.expo'] }
```

In `mobile/package.json` add scripts:
```json
"scripts": {
  "start": "expo start",
  "test": "jest",
  "lint": "eslint .",
  "typecheck": "tsc --noEmit"
}
```
(Keep whatever `start`/etc. the template generated; merge.)

- [ ] **Step 4: Smoke test — a trivial passing jest test**

Create `mobile/src/__tests__/smoke.test.ts`:
```ts
test('toolchain runs', () => { expect(1 + 1).toBe(2) })
```

Run, iterating config until all three are green:
```bash
cd /Users/hg/project/Shepherd/mobile
npx tsc --noEmit
npx eslint . || true   # fix real errors; the template may need minor eslint tweaks
npx jest --ci
```
Expected: tsc clean; jest passes the smoke test. If `jest-expo`/babel needs a
`babel.config.js` with `babel-preset-expo`, ensure one exists (the template
usually provides it). Resolve any version/peer-dep issues from Step 2 here.

- [ ] **Step 5: Commit**

```bash
cd /Users/hg/project/Shepherd
echo "" >> .gitignore  # ensure trailing newline
printf '/mobile/node_modules/\n/mobile/.expo/\n/mobile/dist/\n' >> .gitignore
git add mobile/ .gitignore
git commit -m "feat(mobile): scaffold Expo app (expo-router + TS) + jest/eslint toolchain"
```
(Confirm `mobile/node_modules` is NOT staged — the `.gitignore` entry must exclude it; `git status` should show `package.json`/`package-lock.json`/configs/app, not the dep tree.)

**Report** the installed Expo SDK + key package versions so later tasks match.

---

## Task 2: `storage/secure.ts`

**Files:** Create `mobile/src/storage/secure.ts`; Test `mobile/src/storage/__tests__/secure.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { saveToken, loadToken, clearToken, saveBaseURL, loadBaseURL } from '../secure'

test('token round-trips and clears', async () => {
  expect(await loadToken()).toBeNull()
  await saveToken('tok-123')
  expect(await loadToken()).toBe('tok-123')
  await clearToken()
  expect(await loadToken()).toBeNull()
})

test('baseURL round-trips', async () => {
  await saveBaseURL('https://shep.example')
  expect(await loadBaseURL()).toBe('https://shep.example')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest src/storage`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/storage/secure.ts`**

```ts
import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'

const TOKEN_KEY = 'shepherd_token'
const BASE_URL_KEY = 'shepherd_base_url'

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token)
}
export async function loadToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY)
}
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY)
}
export async function saveBaseURL(url: string): Promise<void> {
  await AsyncStorage.setItem(BASE_URL_KEY, url)
}
export async function loadBaseURL(): Promise<string | null> {
  return AsyncStorage.getItem(BASE_URL_KEY)
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd mobile && npx jest src/storage && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/storage/
git commit -m "feat(mobile): secure token + baseURL storage wrapper"
```

---

## Task 3: `api/client.ts`

**Files:** Create `mobile/src/api/client.ts`; Test `mobile/src/api/__tests__/client.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { apiFetch, APIError } from '../client'

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response)

afterEach(() => { (global.fetch as jest.Mock | undefined)?.mockReset?.() })

test('attaches bearer + parses json', async () => {
  global.fetch = jest.fn(() => okJson({ n: 1 })) as unknown as typeof fetch
  const out = await apiFetch<{ n: number }>('https://h', 'tok', '/api/x')
  expect(out.n).toBe(1)
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect(url).toBe('https://h/api/x')
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
})

test('omits bearer when token null', async () => {
  global.fetch = jest.fn(() => okJson({})) as unknown as typeof fetch
  await apiFetch('https://h', null, '/api/x')
  const [, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
})

test('throws APIError with server message on non-2xx', async () => {
  global.fetch = jest.fn(() => okJson({ error: 'nope' }, 400)) as unknown as typeof fetch
  await expect(apiFetch('https://h', 't', '/x')).rejects.toMatchObject({ status: 400, message: 'nope' })
})

test('401 surfaces as APIError(401)', async () => {
  global.fetch = jest.fn(() => okJson({ error: 'unauthorized' }, 401)) as unknown as typeof fetch
  await expect(apiFetch('https://h', 't', '/x')).rejects.toBeInstanceOf(APIError)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest src/api/__tests__/client`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/api/client.ts`**

```ts
export class APIError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'APIError'
  }
}

export async function apiFetch<T>(
  baseURL: string,
  token: string | null,
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${baseURL}${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  let parsed: unknown = null
  try {
    parsed = await res.json()
  } catch {
    parsed = null
  }
  if (!res.ok) {
    const msg = (parsed as { error?: string } | null)?.error ?? `request failed (${res.status})`
    throw new APIError(res.status, msg)
  }
  return parsed as T
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd mobile && npx jest src/api/__tests__/client && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/api/client.ts mobile/src/api/__tests__/client.test.ts
git commit -m "feat(mobile): typed apiFetch (bearer + APIError normalization)"
```

---

## Task 4: `api/auth.ts`

**Files:** Create `mobile/src/api/auth.ts`; Test `mobile/src/api/__tests__/auth.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { loginRequest, logoutRequest } from '../auth'

test('loginRequest posts client=mobile and returns token', async () => {
  const fetchMock = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 1, username: 'a', token: 'T' }) } as Response))
  global.fetch = fetchMock as unknown as typeof fetch
  const r = await loginRequest('https://h', 'a', 'p')
  expect(r.token).toBe('T')
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://h/api/login')
  expect(JSON.parse(init.body as string)).toEqual({ username: 'a', password: 'p', client: 'mobile' })
})

test('loginRequest throws when server returns no token (not R1+)', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 1, username: 'a' }) } as Response)) as unknown as typeof fetch
  await expect(loginRequest('https://h', 'a', 'p')).rejects.toThrow()
})

test('logoutRequest posts with bearer', async () => {
  const fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) } as unknown as Response))
  global.fetch = fetchMock as unknown as typeof fetch
  await logoutRequest('https://h', 'T')
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('https://h/api/logout')
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer T')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest src/api/__tests__/auth`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/api/auth.ts`**

```ts
import { apiFetch, APIError } from './client'

export type LoginResult = { id: number; username: string; token: string }

export async function loginRequest(baseURL: string, username: string, password: string): Promise<LoginResult> {
  const r = await apiFetch<{ id: number; username: string; token?: string }>(
    baseURL, null, '/api/login', { body: { username, password, client: 'mobile' } },
  )
  if (!r.token) {
    throw new APIError(500, 'server did not return a token (update the server to v0.23+)')
  }
  return { id: r.id, username: r.username, token: r.token }
}

export async function logoutRequest(baseURL: string, token: string): Promise<void> {
  await apiFetch<unknown>(baseURL, token, '/api/logout', { method: 'POST' }).catch(() => {})
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd mobile && npx jest src/api/__tests__/auth && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/api/auth.ts mobile/src/api/__tests__/auth.test.ts
git commit -m "feat(mobile): login/logout API calls (opt-in mobile token)"
```

---

## Task 5: `store/auth.ts` (zustand)

**Files:** Create `mobile/src/store/auth.ts`; Test `mobile/src/store/__tests__/auth.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { useAuth } from '../auth'

jest.mock('../../api/auth', () => ({
  loginRequest: jest.fn(),
  logoutRequest: jest.fn(async () => {}),
}))
jest.mock('../../storage/secure', () => {
  let token: string | null = null
  let base: string | null = null
  return {
    saveToken: jest.fn(async (t: string) => { token = t }),
    loadToken: jest.fn(async () => token),
    clearToken: jest.fn(async () => { token = null }),
    saveBaseURL: jest.fn(async (u: string) => { base = u }),
    loadBaseURL: jest.fn(async () => base),
  }
})
import { loginRequest } from '../../api/auth'
import { clearToken, loadToken } from '../../storage/secure'

beforeEach(() => {
  useAuth.setState({ status: 'loading', baseURL: null, token: null, admin: null, error: null })
  ;(loginRequest as jest.Mock).mockReset()
})

test('login success → signedIn + token persisted', async () => {
  ;(loginRequest as jest.Mock).mockResolvedValue({ id: 1, username: 'a', token: 'T' })
  await useAuth.getState().login('https://h', 'a', 'p')
  const s = useAuth.getState()
  expect(s.status).toBe('signedIn')
  expect(s.token).toBe('T')
  expect(await loadToken()).toBe('T')
})

test('login failure → error, stays signedOut', async () => {
  ;(loginRequest as jest.Mock).mockRejectedValue(Object.assign(new Error('bad creds'), { status: 401 }))
  await useAuth.getState().login('https://h', 'a', 'p')
  const s = useAuth.getState()
  expect(s.status).toBe('signedOut')
  expect(s.error).toBe('bad creds')
})

test('restore with stored token → signedIn', async () => {
  ;(loginRequest as jest.Mock).mockResolvedValue({ id: 1, username: 'a', token: 'T' })
  await useAuth.getState().login('https://h', 'a', 'p')
  useAuth.setState({ status: 'loading', token: null, admin: null })
  await useAuth.getState().restore()
  expect(useAuth.getState().status).toBe('signedIn')
})

test('clearSession wipes token + signs out', async () => {
  ;(loginRequest as jest.Mock).mockResolvedValue({ id: 1, username: 'a', token: 'T' })
  await useAuth.getState().login('https://h', 'a', 'p')
  await useAuth.getState().logout()
  expect(useAuth.getState().status).toBe('signedOut')
  expect(await loadToken()).toBeNull()
  expect(clearToken).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest src/store`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mobile/src/store/auth.ts`**

```ts
import { create } from 'zustand'
import { loginRequest, logoutRequest } from '../api/auth'
import { saveToken, loadToken, clearToken, saveBaseURL, loadBaseURL } from '../storage/secure'

type Admin = { id: number; username: string }

type AuthState = {
  status: 'loading' | 'signedOut' | 'signedIn'
  baseURL: string | null
  token: string | null
  admin: Admin | null
  error: string | null
  restore: () => Promise<void>
  login: (baseURL: string, username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearSession: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  baseURL: null,
  token: null,
  admin: null,
  error: null,

  restore: async () => {
    const [token, baseURL] = [await loadToken(), await loadBaseURL()]
    if (token && baseURL) set({ status: 'signedIn', token, baseURL })
    else set({ status: 'signedOut' })
  },

  login: async (baseURL, username, password) => {
    set({ error: null })
    try {
      const r = await loginRequest(baseURL, username, password)
      await saveToken(r.token)
      await saveBaseURL(baseURL)
      set({ status: 'signedIn', token: r.token, baseURL, admin: { id: r.id, username: r.username }, error: null })
    } catch (e) {
      set({ status: 'signedOut', error: e instanceof Error ? e.message : 'login failed' })
    }
  },

  logout: async () => {
    const { baseURL, token } = get()
    if (baseURL && token) await logoutRequest(baseURL, token)
    await get().clearSession()
  },

  clearSession: async () => {
    await clearToken()
    set({ status: 'signedOut', token: null, admin: null })
  },
}))
```

- [ ] **Step 4: Run to verify pass**

Run: `cd mobile && npx jest src/store && npx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 5: Commit**

```bash
git add mobile/src/store/
git commit -m "feat(mobile): zustand auth store (login/logout/restore/clearSession)"
```

---

## Task 6: Theme + routing + login screen

**Files:** Create `mobile/src/theme/index.ts`; replace/author `mobile/app/_layout.tsx`, `mobile/app/(auth)/login.tsx`, `mobile/app/(app)/index.tsx`; Test `mobile/app/__tests__/login.test.tsx`. First READ the template's generated `app/` to match its conventions (it may ship an `app/(tabs)/` or `app/index.tsx` to remove/replace).

- [ ] **Step 1: Write the failing screen test**

`mobile/app/__tests__/login.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import LoginScreen from '../(auth)/login'
import { useAuth } from '../../src/store/auth'

jest.mock('expo-router', () => ({ Redirect: () => null, router: { replace: jest.fn() } }))

test('submitting calls store.login with entered values', () => {
  const login = jest.fn()
  useAuth.setState({ status: 'signedOut', baseURL: null, token: null, admin: null, error: null, login } as never)
  const { getByPlaceholderText, getByText } = render(<LoginScreen />)
  fireEvent.changeText(getByPlaceholderText('https://your-server'), 'https://h')
  fireEvent.changeText(getByPlaceholderText('username'), 'alice')
  fireEvent.changeText(getByPlaceholderText('password'), 'pw')
  fireEvent.press(getByText('Sign in'))
  expect(login).toHaveBeenCalledWith('https://h', 'alice', 'pw')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd mobile && npx jest app/__tests__/login`
Expected: FAIL — screen module not found.

- [ ] **Step 3: Implement theme + screens**

`mobile/src/theme/index.ts`:
```ts
export const theme = {
  bg: '#0a0a0b',
  surface: '#161618',
  border: '#26262a',
  text: '#e7e7ea',
  textDim: '#9a9aa2',
  accent: '#6ea8fe',
  error: '#f08a8a',
  space: (n: number) => n * 4,
}
```

`mobile/app/_layout.tsx` (root: restore on mount, gate by auth):
```tsx
import { useEffect } from 'react'
import { Stack, Redirect, Slot } from 'expo-router'
import { View, ActivityIndicator } from 'react-native'
import { useAuth } from '../src/store/auth'
import { theme } from '../src/theme'

export default function RootLayout() {
  const status = useAuth((s) => s.status)
  const restore = useAuth((s) => s.restore)
  useEffect(() => { restore() }, [restore])

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }
  if (status === 'signedOut') return <Redirect href="/(auth)/login" />
  return (
    <>
      <Redirect href="/(app)" />
      <Slot />
    </>
  )
}
```
(If expo-router's redirect-from-layout pattern differs in the installed version,
implement the equivalent guard: a `loading` splash, then route to `(auth)/login`
when signedOut and `(app)` when signedIn. Adapt to the template's router API; keep
the behaviour.)

`mobile/app/(auth)/login.tsx`:
```tsx
import { useState } from 'react'
import { View, Text, TextInput, Pressable } from 'react-native'
import { useAuth } from '../../src/store/auth'
import { theme } from '../../src/theme'

export default function LoginScreen() {
  const login = useAuth((s) => s.login)
  const error = useAuth((s) => s.error)
  const [url, setUrl] = useState('')
  const [user, setUser] = useState('')
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    await login(url, user, pass)
    setBusy(false)
  }
  const input = { backgroundColor: theme.surface, color: theme.text, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(3), marginBottom: theme.space(2) }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(5), justifyContent: 'center' }}>
      <Text style={{ color: theme.text, fontSize: 22, marginBottom: theme.space(4) }}>Shepherd</Text>
      <TextInput style={input} placeholder="https://your-server" placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false} value={url} onChangeText={setUrl} />
      <TextInput style={input} placeholder="username" placeholderTextColor={theme.textDim} autoCapitalize="none" value={user} onChangeText={setUser} />
      <TextInput style={input} placeholder="password" placeholderTextColor={theme.textDim} secureTextEntry value={pass} onChangeText={setPass} />
      {error ? <Text style={{ color: theme.error, marginBottom: theme.space(2) }}>{error}</Text> : null}
      <Pressable onPress={submit} disabled={busy} style={{ backgroundColor: theme.accent, padding: theme.space(3), borderRadius: 8, alignItems: 'center', opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Sign in</Text>
      </Pressable>
    </View>
  )
}
```

`mobile/app/(app)/index.tsx`:
```tsx
import { View, Text, Pressable } from 'react-native'
import { useAuth } from '../../src/store/auth'
import { theme } from '../../src/theme'

export default function Home() {
  const { baseURL, admin, logout } = useAuth()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(5), justifyContent: 'center' }}>
      <Text style={{ color: theme.text, fontSize: 18 }}>Connected to {baseURL}</Text>
      <Text style={{ color: theme.textDim, marginTop: theme.space(1) }}>as {admin?.username ?? '—'}</Text>
      <Pressable onPress={logout} style={{ marginTop: theme.space(6), padding: theme.space(3), borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
        <Text style={{ color: theme.text }}>Log out</Text>
      </Pressable>
    </View>
  )
}
```

Remove any leftover starter screens from the template (e.g. `app/index.tsx` or
`app/(tabs)/`) that conflict with this routing. Ensure `app/(auth)/` and
`app/(app)/` group dirs exist.

- [ ] **Step 4: Run to verify pass**

Run: `cd mobile && npx jest && npx tsc --noEmit && npx eslint .`
Expected: PASS (all tests incl. the login screen); tsc clean; eslint clean (fix any lint).

- [ ] **Step 5: Commit**

```bash
git add mobile/src/theme/ mobile/app/
git commit -m "feat(mobile): theme + auth-gated routing + login & home screens"
```

---

## Task 7: CI mobile job + ignore

**Files:** Modify `.github/workflows/ci.yml`; ensure root `.gitignore` covers mobile.

- [ ] **Step 1: Add the `mobile` CI job**

In `.github/workflows/ci.yml`, after the `web:` job, add (same indentation level as `web`):
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
      - name: Install mobile deps
        run: cd mobile && npm ci
      - name: Typecheck
        run: cd mobile && npx tsc --noEmit
      - name: Lint
        run: cd mobile && npx eslint .
      - name: Jest
        run: cd mobile && npx jest --ci
```

- [ ] **Step 2: Verify the workflow is valid YAML + the commands match local**

Run: `cd /Users/hg/project/Shepherd && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"`
Confirm the four `mobile` commands match what passed locally in Tasks 1–6.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml .gitignore
git commit -m "ci: add mobile job (tsc + eslint + jest)"
```

---

## Task 8: Full verification

**Files:** none.

- [ ] **Step 1: Mobile gates**

Run: `cd /Users/hg/project/Shepherd/mobile && npx tsc --noEmit && npx eslint . && npx jest --ci`
Expected: all green.

- [ ] **Step 2: Backend/web untouched**

Run: `cd /Users/hg/project/Shepherd && go build ./... && (cd web && npx tsc --noEmit)`
Expected: clean (R2 added only `mobile/` + the CI job + `.gitignore`).

- [ ] **Step 3: Hygiene**

Run: `cd /Users/hg/project/Shepherd && git status --porcelain | grep -i node_modules && echo "LEAK" || echo "no node_modules tracked"`
Expected: "no node_modules tracked" (mobile/node_modules ignored). Confirm `mobile/package-lock.json` IS committed (CI `npm ci` needs it).

---

## Self-Review

- **Spec coverage:** scaffold + toolchain → Task 1; `storage/secure` → T2; `api/client` → T3; `api/auth` → T4; `store/auth` → T5; theme + routing + login/home → T6; CI mobile job + ignore → T7; gates → T8. All spec components mapped.
- **Type consistency:** `apiFetch(baseURL, token, path, opts)` (T3) used by `loginRequest`/`logoutRequest` (T4) and consumed via the store (T5); `useAuth` state shape (T5) matches what `_layout`/`login`/`index` read (T6); `LoginResult{id,username,token}` consistent across T4–T5; storage fn names (T2) match the store's imports (T5).
- **Placeholders:** none — complete code for our modules + tests. Task 1 and the T6 router are explicitly adaptive to the installed Expo template version (the only environment-variable parts), with the required end behaviour stated.
- **Risk note:** Task 1 is environment-sensitive (Expo SDK/version resolution, jest-expo config); the subagent iterates to a green `tsc`/`jest` baseline and reports versions. The login-screen test mocks `expo-router`, so it doesn't depend on the router's runtime. Device boot is unverifiable headlessly — the user smoke-tests via `expo start`.
