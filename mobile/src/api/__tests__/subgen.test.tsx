import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useSubscriptions, useTemplates, useSubscriptionInbounds, useAllProxyInbounds,
  listSubscriptions, listTemplates, listSubscriptionInbounds,
  createSubscription, updateSubscription, deleteSubscription, rotateToken, deleteTemplate,
  buildSubURL, SUB_TARGETS,
  type Subscription, type Template, type Selection,
} from '../subgen'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { (authedFetch as jest.Mock).mockReset() })

// ── wire shapes: subscriptionView / templateView / Selection are PLAIN values ──

test('useSubscriptions hits /subscriptions and returns plain (no sql.Null*) views', async () => {
  // Deliberately the FLAT shape the Go handler emits — id/name/token/template_id/
  // enabled are all bare scalars; there is NO {String,Valid} object anywhere.
  const rows: Subscription[] = [
    { id: 1, name: 'phone', token: 'pub-secret-aaa', template_id: 3, enabled: true },
    { id: 2, name: 'laptop', token: 'pub-secret-bbb', template_id: 0, enabled: false },
  ]
  ;(authedFetch as jest.Mock).mockResolvedValue(rows)
  const { result } = renderHook(() => useSubscriptions(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/subgen/subscriptions')
  expect(result.current.data?.[0]).toEqual({ id: 1, name: 'phone', token: 'pub-secret-aaa', template_id: 3, enabled: true })
  // token is a plain string secret, not nested
  expect(typeof result.current.data?.[0].token).toBe('string')
})

test('useTemplates hits /templates; rules_json is a STRING of JSON, builtin is plain bool', async () => {
  const rows: Template[] = [
    { id: 10, name: 'Default', builtin: true, rules_json: '{"final":"DIRECT"}' },
    { id: 11, name: 'My rules', builtin: false, rules_json: '{"final":"PROXY","groups":[]}' },
  ]
  ;(authedFetch as jest.Mock).mockResolvedValue(rows)
  const { result } = renderHook(() => useTemplates(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/subgen/templates')
  expect(typeof result.current.data?.[0].rules_json).toBe('string')
  expect(result.current.data?.[1].builtin).toBe(false)
})

test('useSubscriptionInbounds hits /{id}/inbounds and is disabled when id is null', async () => {
  const rows: Selection[] = [
    { source: 'xray', inbound_id: 5 },
    { source: 'singbox', inbound_id: 8 },
  ]
  ;(authedFetch as jest.Mock).mockResolvedValue(rows)
  const { result, rerender } = renderHook(
    ({ id }: { id: number | null }) => useSubscriptionInbounds(id),
    { wrapper, initialProps: { id: null as number | null } },
  )
  // disabled while null — no fetch
  expect(authedFetch).not.toHaveBeenCalled()
  rerender({ id: 7 })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/subgen/subscriptions/7/inbounds')
  expect(result.current.data?.[0]).toEqual({ source: 'xray', inbound_id: 5 })
})

test('useAllProxyInbounds lists EVERY inbound with NO server_id filter (the #id-fallback bug fix)', async () => {
  // The singbox/xray /inbounds handler treats a present server_id as an exact
  // match, so server_id=-1 returned EMPTY and every Selection fell back to
  // `${source} #${id}`. Omitting server_id entirely returns ALL inbounds.
  ;(authedFetch as jest.Mock).mockResolvedValue([
    { id: 8, server_id: 9, server_name: 'beta', tag: 'hy2-8', alias: '', port: 443, role: 'landing', protocol: 'hysteria2' },
  ])
  const { result, rerender } = renderHook(
    ({ on }: { on: boolean }) => useAllProxyInbounds('singbox', on),
    { wrapper, initialProps: { on: false } },
  )
  // disabled until the row is open — no fetch
  expect(authedFetch).not.toHaveBeenCalled()
  rerender({ on: true })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  // NO ?server_id= query string — the unfiltered list carries server_id/name.
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/singbox/inbounds')
  expect(result.current.data?.[0].tag).toBe('hy2-8')
})

// ── plain request fns: exact URLs / methods / bodies ───────────────────────────

test('listSubscriptions / listTemplates / listSubscriptionInbounds use the right paths', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([])
  await listSubscriptions()
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/subgen/subscriptions')
  await listTemplates()
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/subgen/templates')
  await listSubscriptionInbounds(42)
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/subgen/subscriptions/42/inbounds')
})

test('createSubscription POSTs only name + template_id (server mints token)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ id: 9, name: 'tv', token: 't', template_id: 3, enabled: true })
  await createSubscription({ name: 'tv', template_id: 3 })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/subgen/subscriptions', {
    method: 'POST',
    body: { name: 'tv', template_id: 3 },
  })
})

test('updateSubscription PATCHes the FULL name+template_id+enabled triple (Go zero-fill trap)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ id: 1, name: 'phone', token: 't', template_id: 3, enabled: false })
  // Toggling enabled off MUST still carry name + template_id, otherwise the Go
  // body's plain non-pointer fields zero-fill the name to '' and template_id to 0.
  await updateSubscription(1, { name: 'phone', template_id: 3, enabled: false })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/subgen/subscriptions/1', {
    method: 'PATCH',
    body: { name: 'phone', template_id: 3, enabled: false },
  })
})

test('deleteSubscription / deleteTemplate issue DELETEs to the right ids', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(null) // 204, empty body
  await deleteSubscription(4)
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/subgen/subscriptions/4', { method: 'DELETE' })
  await deleteTemplate(11)
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/subgen/templates/11', { method: 'DELETE' })
})

test('rotateToken POSTs an empty body and returns the NEW token', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ token: 'fresh-secret' })
  const r = await rotateToken(6)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/subgen/subscriptions/6/rotate-token', { method: 'POST' })
  expect(r.token).toBe('fresh-secret')
})

// ── public /sub URL builder (ROOT mux, NOT /api; token is the secret) ──────────

test('buildSubURL puts /sub on the ROOT origin (no /api), with the target query', () => {
  expect(buildSubURL('https://h.example', 'abc123', 'surge'))
    .toBe('https://h.example/sub/abc123?target=surge')
  // trailing slashes on the baseURL are trimmed so we never get //sub
  expect(buildSubURL('https://h.example/', 'abc123', 'clash'))
    .toBe('https://h.example/sub/abc123?target=clash')
  expect(buildSubURL('http://localhost:8080///', 'tok', 'shadowrocket'))
    .toBe('http://localhost:8080/sub/tok?target=shadowrocket')
  // never under /api/admin
  expect(buildSubURL('https://h.example', 'abc123', 'surge')).not.toContain('/api')
})

test('buildSubURL encodes the token and returns "" when baseURL is unknown', () => {
  expect(buildSubURL('https://h.example', 'a b/c', 'surge'))
    .toBe('https://h.example/sub/a%20b%2Fc?target=surge')
  expect(buildSubURL(null, 'tok', 'surge')).toBe('')
  expect(buildSubURL(undefined, 'tok', 'surge')).toBe('')
})

test('SUB_TARGETS covers all four renderer targets', () => {
  expect(SUB_TARGETS).toEqual(['surge', 'shadowrocket', 'clash', 'quantumultx'])
})
