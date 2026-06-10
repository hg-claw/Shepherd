import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuditLog } from '../audit'

jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

test('useAuditLog hits the bare endpoint and resolves rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([
    { id: 1, ts: '2026-06-09T00:00:00Z', admin_id: 1, server_id: 7, action: 'server.deploy', details: '{"plugin":"caddy"}', result: 'ok' },
  ])
  const { result } = renderHook(() => useAuditLog(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/audit')
  expect(result.current.data?.[0].action).toBe('server.deploy')
  expect(result.current.data?.[0].result).toBe('ok')
})

test('useAuditLog passes the action filter as a query param', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([])
  const { result } = renderHook(() => useAuditLog({ action: 'login attempt' }), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/audit?action=login%20attempt')
})

test('useAuditLog surfaces error', async () => {
  ;(authedFetch as jest.Mock).mockRejectedValue(new Error('nope'))
  const { result } = renderHook(() => useAuditLog(), { wrapper })
  await waitFor(() => expect(result.current.isError).toBe(true))
})
