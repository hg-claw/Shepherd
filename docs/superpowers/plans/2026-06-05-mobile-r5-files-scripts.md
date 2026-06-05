# Mobile R5 — Files (read-only) + Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only file browser (list dirs + text preview) and scripts (list, run on the current server, poll status) in the Expo app.

**Architecture:** `authedText` adds a text-body sibling to `authedFetch` (preview is `text/plain`). `files.ts`/`scripts.ts` wrap them as TanStack hooks; pure `paths.ts` builds child/parent/breadcrumb paths (FileEntry has no `path` field — only `name`). Screens compose them. All logic + screen renders are unit-tested.

**Tech Stack:** Expo SDK 56 + expo-router, TanStack Query, jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-06-05-mobile-r5-files-scripts-design.md`

**Headless:** verify only with `cd mobile && npx tsc --noEmit && npx eslint . && npx jest`. No new native dep this round (no lock change), but T10 still runs a clean `npm ci`.

**Backend shapes (confirmed):** `FileEntry={name,size,mode,mtime(unix sec),is_dir,is_link?}` (NO path); preview → `text/plain` (415 for binary); `Script={id,name,description,content,params:[{name,label?,required?,default?}]}`; run → `{run_id}`; run-detail → `RunTarget[]={id,server_id,pty_session_id?,status,exit_code?,started_at,finished_at?}` (no output text — output is PTY-based, deferred).

---

## Task 1: `authedText`

**Files:** Modify `mobile/src/api/authed.ts`; Test `mobile/src/api/__tests__/authedText.test.ts`.

- [ ] **Step 1: Failing test**
```ts
import { authedText } from '../authed'
import { APIError } from '../client'
import { useAuth } from '../../store/auth'

beforeEach(() => { useAuth.setState({ status: 'signedIn', baseURL: 'https://h', token: 'T', admin: null, error: null }) })

test('200 returns text', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('hello') } as Response)) as unknown as typeof fetch
  await expect(authedText('/p')).resolves.toBe('hello')
  const [, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer T')
})
test('401 clears session and throws', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('') } as Response)) as unknown as typeof fetch
  await expect(authedText('/p')).rejects.toBeInstanceOf(APIError)
  expect(useAuth.getState().status).toBe('signedOut')
})
test('non-401 throws without clearing', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 415, text: () => Promise.resolve('binary') } as Response)) as unknown as typeof fetch
  await expect(authedText('/p')).rejects.toMatchObject({ status: 415 })
  expect(useAuth.getState().status).toBe('signedIn')
})
test('missing baseURL throws without fetch', async () => {
  useAuth.setState({ baseURL: null })
  global.fetch = jest.fn() as unknown as typeof fetch
  await expect(authedText('/p')).rejects.toBeInstanceOf(APIError)
  expect(global.fetch).not.toHaveBeenCalled()
})
```
Run `npx jest src/api/__tests__/authedText` → FAIL.

- [ ] **Step 2: Implement** — append to `mobile/src/api/authed.ts`:
```ts
export async function authedText(path: string): Promise<string> {
  const { baseURL, token } = useAuth.getState()
  if (!baseURL) throw new APIError(401, 'not signed in')
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${baseURL}${path}`, { headers })
  const body = await res.text().catch(() => '')
  if (!res.ok) {
    if (res.status === 401) await useAuth.getState().clearSession()
    throw new APIError(res.status, body || `request failed (${res.status})`)
  }
  return body
}
```
(Confirm `APIError`/`useAuth` are already imported in `authed.ts`.)

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/api/__tests__/authedText && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/api/authed.ts mobile/src/api/__tests__/authedText.test.ts
git commit -m "feat(mobile): authedText (text/plain authed fetch, 401->clearSession)"
```

---

## Task 2: paths + files API

**Files:** Create `mobile/src/lib/paths.ts`, `mobile/src/api/files.ts` + tests.

- [ ] **Step 1: Failing tests**
`mobile/src/lib/__tests__/paths.test.ts`:
```ts
import { joinPath, parentPath, crumbs } from '../paths'
test('joinPath', () => {
  expect(joinPath('/a/b', 'c')).toBe('/a/b/c')
  expect(joinPath('/', 'c')).toBe('/c')
  expect(joinPath('/a/', 'b')).toBe('/a/b')
})
test('parentPath', () => {
  expect(parentPath('/a/b')).toBe('/a')
  expect(parentPath('/a')).toBe('/')
  expect(parentPath('/')).toBe('/')
})
test('crumbs', () => {
  expect(crumbs('/a/b')).toEqual([{ label: '/', path: '/' }, { label: 'a', path: '/a' }, { label: 'b', path: '/a/b' }])
})
```
`mobile/src/api/__tests__/files.test.ts`:
```ts
import { listDir, previewFile } from '../files'
jest.mock('../authed', () => ({ authedFetch: jest.fn(), authedText: jest.fn() }))
import { authedFetch, authedText } from '../authed'

test('listDir hits the right url', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ name: 'x', is_dir: true, size: 0, mode: 0, mtime: 0 }])
  const out = await listDir(7, '/etc')
  expect(out[0].name).toBe('x')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/files?server_id=7&path=%2Fetc')
})
test('previewFile returns text', async () => {
  ;(authedText as jest.Mock).mockResolvedValue('contents')
  await expect(previewFile(7, '/a.txt')).resolves.toEqual({ kind: 'text', text: 'contents' })
})
test('previewFile maps 415 to binary', async () => {
  const { APIError } = jest.requireActual('../client')
  ;(authedText as jest.Mock).mockRejectedValue(new APIError(415, 'binary content'))
  await expect(previewFile(7, '/a.bin')).resolves.toEqual({ kind: 'binary' })
})
```
Run `npx jest src/lib/__tests__/paths src/api/__tests__/files` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/lib/paths.ts`:
```ts
export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`.replace(/\/{2,}/g, '/')
}
export function parentPath(path: string): string {
  if (path === '/' || path === '') return '/'
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}
export function crumbs(path: string): { label: string; path: string }[] {
  const out = [{ label: '/', path: '/' }]
  let acc = ''
  for (const seg of path.split('/').filter(Boolean)) {
    acc += '/' + seg
    out.push({ label: seg, path: acc })
  }
  return out
}
```
`mobile/src/api/files.ts`:
```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch, authedText } from './authed'
import { APIError } from './client'

export type FileEntry = { name: string; size: number; mode: number; mtime: number; is_dir: boolean; is_link?: boolean }
export type Preview = { kind: 'text'; text: string } | { kind: 'binary' }

export function listDir(serverId: number, path: string): Promise<FileEntry[]> {
  return authedFetch<FileEntry[]>(`/api/admin/files?server_id=${serverId}&path=${encodeURIComponent(path)}`)
}
export async function previewFile(serverId: number, path: string): Promise<Preview> {
  try {
    const text = await authedText(`/api/admin/files/preview?server_id=${serverId}&path=${encodeURIComponent(path)}&max_bytes=65536`)
    return { kind: 'text', text }
  } catch (e) {
    if (e instanceof APIError && e.status === 415) return { kind: 'binary' }
    throw e
  }
}
export function useDir(serverId: number, path: string): UseQueryResult<FileEntry[]> {
  return useQuery({ queryKey: ['files', serverId, path], queryFn: () => listDir(serverId, path) })
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/lib/__tests__/paths src/api/__tests__/files && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/lib/paths.ts mobile/src/api/files.ts mobile/src/lib/__tests__/paths.test.ts mobile/src/api/__tests__/files.test.ts
git commit -m "feat(mobile): path helpers + files listDir/previewFile/useDir"
```

---

## Task 3: scripts API

**Files:** Create `mobile/src/api/scripts.ts` + test.

- [ ] **Step 1: Failing test** `mobile/src/api/__tests__/scripts.test.tsx`:
```tsx
import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useScripts, runScript } from '../scripts'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

test('useScripts resolves', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ id: 1, name: 's', params: [] }])
  const { result } = renderHook(() => useScripts(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.[0].name).toBe('s')
})
test('runScript posts args + single target', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ run_id: 9 })
  const r = await runScript(1, { a: 'b' }, 7)
  expect(r.run_id).toBe(9)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/scripts/1/run', { method: 'POST', body: { args: { a: 'b' }, target_server_ids: [7] } })
})
```
Run `npx jest src/api/__tests__/scripts` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/api/scripts.ts`:
```ts
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { authedFetch } from './authed'

export type ScriptParam = { name: string; label?: string; required?: boolean; default?: string }
export type Script = { id: number; name: string; description?: string; params: ScriptParam[] }
export type RunTarget = { id: number; server_id: number; status: string; exit_code?: number; started_at?: string; finished_at?: string }

const TERMINAL = new Set(['done', 'success', 'failed', 'error', 'timeout', 'cancelled'])

export function useScripts(): UseQueryResult<Script[]> {
  return useQuery({ queryKey: ['scripts'], queryFn: () => authedFetch<Script[]>('/api/admin/scripts') })
}
export function runScript(id: number, args: Record<string, string>, serverId: number): Promise<{ run_id: number }> {
  return authedFetch<{ run_id: number }>(`/api/admin/scripts/${id}/run`, { method: 'POST', body: { args, target_server_ids: [serverId] } })
}
export function useRun(runId: number | null): UseQueryResult<RunTarget[]> {
  return useQuery({
    queryKey: ['run', runId],
    enabled: runId != null,
    queryFn: () => authedFetch<RunTarget[]>(`/api/admin/script-runs/${runId}`),
    refetchInterval: (q) => {
      const rows = q.state.data as RunTarget[] | undefined
      const allDone = rows && rows.length > 0 && rows.every((t) => TERMINAL.has(t.status))
      return allDone ? false : 2000
    },
  })
}
```
(If the TanStack v5 `refetchInterval` callback signature differs from `(query)`, adapt to the installed version's signature — the contract is "poll 2s until every target status is terminal, then stop"; report any change.)

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest src/api/__tests__/scripts && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add mobile/src/api/scripts.ts mobile/src/api/__tests__/scripts.test.tsx
git commit -m "feat(mobile): scripts useScripts/runScript/useRun (poll to terminal)"
```

---

## Task 4: File browser screen

**Files:** Create `mobile/src/app/(app)/files/[id].tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/files/__tests__/browser.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent } from '@testing-library/react-native'
import FileBrowser from '../[id]'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7' }), useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/api/files', () => ({ useDir: jest.fn() }))
import { useDir } from '@/api/files'

test('renders entries dirs-first and cd into a dir', () => {
  ;(useDir as jest.Mock).mockReturnValue({ data: [
    { name: 'file.txt', is_dir: false, size: 1, mode: 0, mtime: 0 },
    { name: 'sub', is_dir: true, size: 0, mode: 0, mtime: 0 },
  ], isLoading: false, isError: false, refetch: jest.fn(), isRefetching: false })
  const { getByText } = render(<FileBrowser />)
  expect(getByText('sub')).toBeTruthy()
  expect(getByText('file.txt')).toBeTruthy()
  fireEvent.press(getByText('sub')) // cd → useDir is called again with the child path (re-render)
})
```
Run `npx jest "src/app/(app)/files/__tests__/browser"` → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/files/[id].tsx`:
```tsx
import { useState } from 'react'
import { View, Text, Pressable, FlatList, RefreshControl, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useDir, type FileEntry } from '@/api/files'
import { joinPath, parentPath, crumbs } from '@/lib/paths'
import { theme } from '@/theme'

export default function FileBrowser() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const sid = Number(id)
  const router = useRouter()
  const [path, setPath] = useState('/')
  const q = useDir(sid, path)
  const entries = (q.data ?? []).slice().sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1))

  const openEntry = (e: FileEntry) => {
    const full = joinPath(path, e.name)
    if (e.is_dir) setPath(full)
    else router.push(`/(app)/files/${sid}/preview?path=${encodeURIComponent(full)}`)
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', padding: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
        {crumbs(path).map((c, i) => (
          <Pressable key={i} onPress={() => setPath(c.path)}><Text style={{ color: theme.accent, fontFamily: 'monospace' }}>{c.label === '/' ? '/' : `${c.label}/`}</Text></Pressable>
        ))}
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>{q.error instanceof Error ? q.error.message : 'failed'}</Text>
        : <FlatList
            data={entries}
            keyExtractor={(e) => e.name}
            ListHeaderComponent={path !== '/' ? <Pressable onPress={() => setPath(parentPath(path))} style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}><Text style={{ color: theme.textDim }}>..</Text></Pressable> : null}
            renderItem={({ item }) => (
              <Pressable onPress={() => openEntry(item)} style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
                <Text style={{ color: item.is_dir ? theme.accent : theme.text, flex: 1, fontFamily: 'monospace' }}>{item.is_dir ? `${item.name}/` : item.name}</Text>
                {!item.is_dir ? <Text style={{ color: theme.textDim, fontSize: 12 }}>{item.size}B</Text> : null}
              </Pressable>
            )}
            refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={theme.accent} />}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>Empty.</Text>}
          />}
    </View>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/files/__tests__/browser" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/files/[id].tsx" "mobile/src/app/(app)/files/__tests__/browser.test.tsx"
git commit -m "feat(mobile): read-only file browser (breadcrumbs, dirs-first, cd)"
```

---

## Task 5: File preview screen

**Files:** Create `mobile/src/app/(app)/files/[id]/preview.tsx` + test.
(NOTE: this makes `files/[id]` a directory — expo-router needs `files/[id].tsx` to become `files/[id]/index.tsx`. Move the Task-4 browser to `files/[id]/index.tsx` and put preview at `files/[id]/preview.tsx`. Update the browser's import paths (`@/...` are absolute, unaffected) and its test import (`../index`). The router push target `/(app)/files/${sid}/preview` already matches.)

- [ ] **Step 1: Restructure + failing test**
Move `mobile/src/app/(app)/files/[id].tsx` → `mobile/src/app/(app)/files/[id]/index.tsx` (git mv); update the browser test import from `../[id]` to `../index` and its path `src/app/(app)/files/__tests__/` stays (the `__tests__` dir is now under `files/[id]/`? No — keep tests at `files/__tests__/` referencing `../[id]/index`). Simplest: put the browser test at `mobile/src/app/(app)/files/[id]/__tests__/browser.test.tsx` importing `../index`, and the preview test at `.../[id]/__tests__/preview.test.tsx`.

Create `mobile/src/app/(app)/files/[id]/__tests__/preview.test.tsx`:
```tsx
import React from 'react'
import { render, waitFor } from '@testing-library/react-native'
import Preview from '../preview'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '7', path: '/a.txt' }) }))
jest.mock('@/api/files', () => ({ previewFile: jest.fn() }))
import { previewFile } from '@/api/files'

test('renders text content', async () => {
  ;(previewFile as jest.Mock).mockResolvedValue({ kind: 'text', text: 'hello world' })
  const { getByText } = render(<Preview />)
  await waitFor(() => expect(getByText('hello world')).toBeTruthy())
})
test('renders binary notice', async () => {
  ;(previewFile as jest.Mock).mockResolvedValue({ kind: 'binary' })
  const { getByText } = render(<Preview />)
  await waitFor(() => expect(getByText(/binary/i)).toBeTruthy())
})
```
Run → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/files/[id]/preview.tsx`:
```tsx
import { useEffect, useState } from 'react'
import { ScrollView, Text, View, ActivityIndicator } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { previewFile, type Preview as Prev } from '@/api/files'
import { theme } from '@/theme'

export default function Preview() {
  const { id, path } = useLocalSearchParams<{ id: string; path: string }>()
  const [state, setState] = useState<{ loading: boolean; data?: Prev; error?: string }>({ loading: true })
  useEffect(() => {
    let live = true
    previewFile(Number(id), String(path))
      .then((d) => { if (live) setState({ loading: false, data: d }) })
      .catch((e) => { if (live) setState({ loading: false, error: e instanceof Error ? e.message : 'failed' }) })
    return () => { live = false }
  }, [id, path])

  if (state.loading) return <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}><ActivityIndicator color={theme.accent} /></View>
  if (state.error) return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}><Text style={{ color: theme.error }}>{state.error}</Text></View>
  if (state.data?.kind === 'binary') return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}><Text style={{ color: theme.textDim }}>Binary file — can&apos;t preview.</Text></View>
  const text = state.data?.kind === 'text' ? state.data.text : ''
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(3) }}>
      <Text style={{ color: theme.text, fontFamily: 'monospace', fontSize: 12 }}>{text || '(empty)'}</Text>
    </ScrollView>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/files" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/files/"
git commit -m "feat(mobile): file text preview screen (binary/empty states)"
```

---

## Task 6: Scripts list screen

**Files:** Create `mobile/src/app/(app)/scripts/index.tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/scripts/__tests__/list.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import ScriptsList from '../index'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ serverId: '7' }), useRouter: () => ({ push: jest.fn() }) }))
jest.mock('@/api/scripts', () => ({ useScripts: jest.fn() }))
import { useScripts } from '@/api/scripts'

test('renders scripts', () => {
  ;(useScripts as jest.Mock).mockReturnValue({ data: [{ id: 1, name: 'deploy', description: 'd', params: [] }], isLoading: false, isError: false })
  const { getByText } = render(<ScriptsList />)
  expect(getByText('deploy')).toBeTruthy()
})
```
Run → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/scripts/index.tsx`:
```tsx
import { FlatList, View, Text, Pressable, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useScripts } from '@/api/scripts'
import { theme } from '@/theme'

export default function ScriptsList() {
  const { serverId } = useLocalSearchParams<{ serverId: string }>()
  const router = useRouter()
  const q = useScripts()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600' }}>Run a script</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>on server #{serverId}</Text>
      </View>
      {q.isLoading ? <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
        : q.isError ? <Text style={{ color: theme.error, padding: theme.space(4) }}>failed to load scripts</Text>
        : <FlatList
            data={q.data ?? []}
            keyExtractor={(s) => String(s.id)}
            renderItem={({ item }) => (
              <Pressable onPress={() => router.push(`/(app)/scripts/${item.id}?serverId=${serverId}`)} style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
                <Text style={{ color: theme.text, fontWeight: '600' }}>{item.name}</Text>
                {item.description ? <Text style={{ color: theme.textDim, fontSize: 12 }}>{item.description}</Text> : null}
              </Pressable>
            )}
            ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No scripts.</Text>}
          />}
    </View>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/scripts/__tests__/list" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/scripts/index.tsx" "mobile/src/app/(app)/scripts/__tests__/list.test.tsx"
git commit -m "feat(mobile): scripts list screen"
```

---

## Task 7: Script run form

**Files:** Create `mobile/src/app/(app)/scripts/[id].tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/scripts/__tests__/form.test.tsx`:
```tsx
import React from 'react'
import { render, fireEvent, waitFor } from '@testing-library/react-native'
import RunForm from '../[id]'
const push = jest.fn()
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: '1', serverId: '7' }), useRouter: () => ({ push }) }))
const runMock = jest.fn().mockResolvedValue({ run_id: 9 })
jest.mock('@/api/scripts', () => ({
  useScripts: () => ({ data: [{ id: 1, name: 'deploy', params: [{ name: 'tag', required: true }] }] }),
  runScript: (...a: unknown[]) => runMock(...a),
}))

beforeEach(() => { runMock.mockClear(); push.mockClear() })

test('Run is gated on required param, then calls runScript', async () => {
  const { getByText, getByPlaceholderText } = render(<RunForm />)
  fireEvent.press(getByText('Run'))
  expect(runMock).not.toHaveBeenCalled()              // required 'tag' empty
  fireEvent.changeText(getByPlaceholderText('tag'), 'v1')
  fireEvent.press(getByText('Run'))
  await waitFor(() => expect(runMock).toHaveBeenCalledWith(1, { tag: 'v1' }, 7))
})
```
Run → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/scripts/[id].tsx`:
```tsx
import { useState } from 'react'
import { View, Text, TextInput, Pressable, ScrollView } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useScripts, runScript } from '@/api/scripts'
import { theme } from '@/theme'

export default function RunForm() {
  const { id, serverId } = useLocalSearchParams<{ id: string; serverId: string }>()
  const router = useRouter()
  const script = useScripts().data?.find((s) => s.id === Number(id))
  const [args, setArgs] = useState<Record<string, string>>(() =>
    Object.fromEntries((script?.params ?? []).map((p) => [p.name, p.default ?? ''])))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!script) return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}><Text style={{ color: theme.textDim }}>Script not found.</Text></View>

  const missing = script.params.filter((p) => p.required && !(args[p.name] ?? '').trim())
  const run = async () => {
    if (missing.length) { setError(`Required: ${missing.map((p) => p.label ?? p.name).join(', ')}`); return }
    setBusy(true); setError(null)
    try {
      const { run_id } = await runScript(script.id, args, Number(serverId))
      router.push(`/(app)/scripts/run/${run_id}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'run failed') } finally { setBusy(false) }
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(4) }}>
      <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', marginBottom: theme.space(3) }}>{script.name}</Text>
      {script.params.map((p) => (
        <View key={p.name} style={{ marginBottom: theme.space(3) }}>
          <Text style={{ color: theme.textDim, marginBottom: theme.space(1) }}>{p.label ?? p.name}{p.required ? ' *' : ''}</Text>
          <TextInput placeholder={p.name} placeholderTextColor={theme.textDim} autoCapitalize="none" autoCorrect={false}
            value={args[p.name] ?? ''} onChangeText={(t) => setArgs((a) => ({ ...a, [p.name]: t }))}
            style={{ backgroundColor: theme.surface, color: theme.text, borderColor: theme.border, borderWidth: 1, borderRadius: 8, padding: theme.space(3) }} />
        </View>
      ))}
      {error ? <Text style={{ color: theme.error, marginBottom: theme.space(2) }}>{error}</Text> : null}
      <Pressable onPress={run} disabled={busy} style={{ backgroundColor: theme.accent, padding: theme.space(3), borderRadius: 8, alignItems: 'center', opacity: busy ? 0.6 : 1 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Run</Text>
      </Pressable>
    </ScrollView>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/scripts/__tests__/form" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/scripts/[id].tsx" "mobile/src/app/(app)/scripts/__tests__/form.test.tsx"
git commit -m "feat(mobile): script run form (required-param validation, single target)"
```
(NOTE: adding `scripts/[id].tsx` next to `scripts/index.tsx` is fine — `index.tsx` + `[id].tsx` coexist as sibling routes. The run-status route `scripts/run/[runId].tsx` is a separate `run/` subdir — no conflict with `[id].tsx`.)

---

## Task 8: Run status screen

**Files:** Create `mobile/src/app/(app)/scripts/run/[runId].tsx` + test.

- [ ] **Step 1: Failing test** `mobile/src/app/(app)/scripts/run/__tests__/status.test.tsx`:
```tsx
import React from 'react'
import { render } from '@testing-library/react-native'
import RunStatus from '../[runId]'
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ runId: '9' }) }))
jest.mock('@/api/scripts', () => ({ useRun: jest.fn() }))
import { useRun } from '@/api/scripts'

test('renders target status', () => {
  ;(useRun as jest.Mock).mockReturnValue({ data: [{ id: 1, server_id: 7, status: 'done', exit_code: 0 }], isLoading: false })
  const { getByText } = render(<RunStatus />)
  expect(getByText(/done/)).toBeTruthy()
})
```
Run → FAIL.

- [ ] **Step 2: Implement** `mobile/src/app/(app)/scripts/run/[runId].tsx`:
```tsx
import { View, Text, ActivityIndicator, ScrollView } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useRun } from '@/api/scripts'
import { theme } from '@/theme'

export default function RunStatus() {
  const { runId } = useLocalSearchParams<{ runId: string }>()
  const q = useRun(Number(runId))
  const rows = q.data ?? []
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={{ padding: theme.space(4) }}>
      <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', marginBottom: theme.space(3) }}>Run #{runId}</Text>
      {q.isLoading ? <ActivityIndicator color={theme.accent} /> : null}
      {rows.map((t) => (
        <View key={t.id} style={{ paddingVertical: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
          <Text style={{ color: theme.text }}>server #{t.server_id}</Text>
          <Text style={{ color: t.status === 'failed' || t.status === 'error' ? theme.error : theme.textDim, fontFamily: 'monospace' }}>
            {t.status}{t.exit_code != null ? ` (exit ${t.exit_code})` : ''}
          </Text>
        </View>
      ))}
      {!q.isLoading && rows.length === 0 ? <Text style={{ color: theme.textDim }}>queued…</Text> : null}
    </ScrollView>
  )
}
```

- [ ] **Step 3: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx jest "src/app/(app)/scripts/run/__tests__/status" && npx tsc --noEmit && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/scripts/run/"
git commit -m "feat(mobile): script run status screen (polls targets to terminal)"
```

---

## Task 9: Detail entries (Files + Run script)

**Files:** Modify `mobile/src/app/(app)/server/[id].tsx`.

- [ ] **Step 1: Add two buttons** beside the R4 "Open console" (the screen already has `router` + `Pressable` from R4):
```tsx
      <Pressable onPress={() => router.push(`/(app)/files/${row.id}`)} style={{ marginTop: theme.space(3), padding: theme.space(3), borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
        <Text style={{ color: theme.text }}>Files</Text>
      </Pressable>
      <Pressable onPress={() => router.push(`/(app)/scripts?serverId=${row.id}`)} style={{ marginTop: theme.space(3), padding: theme.space(3), borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
        <Text style={{ color: theme.text }}>Run script</Text>
      </Pressable>
```

- [ ] **Step 2: Verify + commit**
```bash
cd /Users/hg/project/Shepherd/mobile && npx tsc --noEmit && npx jest "src/app/(app)/server/__tests__/detail" && npx eslint .
cd /Users/hg/project/Shepherd
git add "mobile/src/app/(app)/server/[id].tsx"
git commit -m "feat(mobile): Files + Run script entries on server detail"
```
Expected: typed routes `/(app)/files/[id]` and `/(app)/scripts` resolve (the route files exist); detail test still passes.

---

## Task 10: Full verification

- [ ] **Step 1: Mobile gates (clean install — CI parity)**
Run: `cd /Users/hg/project/Shepherd/mobile && rm -rf node_modules && npm ci && npx tsc --noEmit && npx eslint . && npx jest --ci`
Expected: `npm ci` exit 0; tsc clean; eslint no errors; all suites pass.

- [ ] **Step 2: Backend/web untouched + hygiene**
Run: `cd /Users/hg/project/Shepherd && go build ./... && git status --porcelain | grep -i node_modules && echo LEAK || echo clean`
Expected: build OK; "clean".

---

## Self-Review
- **Spec coverage:** authedText → T1; files listDir/previewFile/useDir + paths → T2; scripts useScripts/runScript/useRun → T3; file browser → T4; preview → T5; scripts list → T6; run form → T7; run status → T8; detail entries → T9; gates → T10. All spec components mapped.
- **Type consistency:** `authedText(path)` (T1) used by `previewFile` (T2); `FileEntry`/`Preview` (T2) used by browser/preview (T4/T5); `joinPath/parentPath/crumbs` (T2) used by browser (T4); `Script/ScriptParam/RunTarget` + `useScripts/runScript/useRun` (T3) used by scripts screens (T6/T7/T8); `runScript(id,args,serverId)` posts `target_server_ids:[serverId]`.
- **Placeholders:** none. T5 explicitly restructures `files/[id].tsx`→`files/[id]/index.tsx` (expo-router segment-dir rule), with the move + import/test-path updates spelled out.
- **Risk note:** RunDetail is a bare `RunTarget[]` with no output text (output is PTY-based, deferred — status/exit_code only). The `useRun` `refetchInterval` callback signature is flagged as version-adaptable. Screen tests mock the hooks, needing no live query client. No native dep added (no lock churn) but T10 still verifies `npm ci`.
