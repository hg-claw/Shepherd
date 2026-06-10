import React from 'react'
import { renderHook } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { scriptInstall, useScriptInstall } from '../install'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

// Real wire shape from Servers.ScriptInstall (internal/api/admin_servers.go):
// writeJSON(w, 201, {server_id, token, expires_at, command}) — expires_at is a
// Go time.Time, serialized as an RFC3339 string (no sql.Null* in this payload).
const WIRE = {
  server_id: 12,
  token: 'enroll-tok-abc',
  expires_at: '2026-06-09T13:30:00Z',
  command: 'curl -fsSL https://shep.example.com/install.sh | bash -s -- --token enroll-tok-abc',
}

beforeEach(() => (authedFetch as jest.Mock).mockReset())

test('scriptInstall POSTs the exact web payload and returns the wire result', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE)
  const r = await scriptInstall({
    name: 'edge-7',
    public_alias: 'edge',
    public_group: 'asia',
    country_code: 'HK',
    show_on_public: true,
    cn: true,
  })
  expect(authedFetch).toHaveBeenCalledWith('/api/servers/script', {
    method: 'POST',
    body: {
      name: 'edge-7',
      public_alias: 'edge',
      public_group: 'asia',
      country_code: 'HK',
      show_on_public: true,
      cn: true,
    },
  })
  expect(r.server_id).toBe(12)
  expect(r.token).toBe('enroll-tok-abc')
  expect(r.expires_at).toBe('2026-06-09T13:30:00Z')
  expect(r.command).toMatch(/^curl .*--token enroll-tok-abc$/)
})

test('minimal payload: optional fields stay undefined (JSON.stringify drops them)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE)
  await scriptInstall({ name: 'n1', show_on_public: false })
  const [, opts] = (authedFetch as jest.Mock).mock.calls[0] as [string, { body: Record<string, unknown> }]
  expect(opts.body).toEqual({ name: 'n1', show_on_public: false })
  expect(JSON.parse(JSON.stringify(opts.body))).toEqual({ name: 'n1', show_on_public: false })
})

test('useScriptInstall invalidates the servers list after a successful issue', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(WIRE)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const spy = jest.spyOn(qc, 'invalidateQueries')
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useScriptInstall(), { wrapper })
  const r = await result.current({ name: 'n1', show_on_public: false })
  expect(r.command).toBe(WIRE.command)
  expect(spy).toHaveBeenCalledWith({ queryKey: ['servers'] })
})

test('useScriptInstall surfaces the API error and does not invalidate', async () => {
  ;(authedFetch as jest.Mock).mockRejectedValue(new Error('name required'))
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const spy = jest.spyOn(qc, 'invalidateQueries')
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  const { result } = renderHook(() => useScriptInstall(), { wrapper })
  await expect(result.current({ name: '', show_on_public: false })).rejects.toThrow('name required')
  expect(spy).not.toHaveBeenCalled()
})
