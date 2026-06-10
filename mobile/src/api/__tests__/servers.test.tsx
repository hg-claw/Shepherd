import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useServers, useServersLatest, useHostTraffic, updateAgent, repairServer, deleteServer } from '../servers'

jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

test('useServers resolves to rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ id: 1, name: 'srv1', connected: true, latest: null }])
  const { result } = renderHook(() => useServers(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.[0].name).toBe('srv1')
  expect(authedFetch).toHaveBeenCalledWith('/api/servers') // fast list — no telemetry join
})

test('useServersLatest hits the with=latest path', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ id: 1, name: 'srv1', connected: true, latest: null }])
  const { result } = renderHook(() => useServersLatest(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/servers?with=latest')
})

test('useServers surfaces error', async () => {
  ;(authedFetch as jest.Mock).mockRejectedValue(new Error('nope'))
  const { result } = renderHook(() => useServers(), { wrapper })
  await waitFor(() => expect(result.current.isError).toBe(true))
})

test('useHostTraffic hits the traffic endpoint and resolves the cycle shape', async () => {
  const traffic = {
    server_id: 7,
    cum_bytes_up: 1536, cum_bytes_down: 1073741824,
    prev_bytes_up: 0, prev_bytes_down: 52428800,
    reset_day: 1, last_reset_at: null,
  }
  ;(authedFetch as jest.Mock).mockResolvedValue(traffic)
  const { result } = renderHook(() => useHostTraffic(7), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/servers/7/traffic')
  expect(result.current.data).toEqual(traffic)
})

test('updateAgent POSTs without the cn flag by default', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(null) // 202, empty body
  await updateAgent(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/servers/7/update-agent', { method: 'POST' })
})

test('updateAgent appends ?cn=1 for the CN mirror', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue(null)
  await updateAgent(7, true)
  expect(authedFetch).toHaveBeenCalledWith('/api/servers/7/update-agent?cn=1', { method: 'POST' })
})

test('repairServer POSTs and returns the enrollment token', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ enrollment_token: 'tok-abc', expires_at: '2026-06-09T12:00:00Z' })
  const out = await repairServer(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/servers/7/repair', { method: 'POST' })
  expect(out.enrollment_token).toBe('tok-abc')
  expect(out.expires_at).toBe('2026-06-09T12:00:00Z')
})

test('deleteServer issues a DELETE', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await deleteServer(7)
  expect(authedFetch).toHaveBeenCalledWith('/api/servers/7', { method: 'DELETE' })
})
