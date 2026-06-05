import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useServers } from '../servers'

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
  expect(authedFetch).toHaveBeenCalledWith('/api/servers?with=latest')
})

test('useServers surfaces error', async () => {
  ;(authedFetch as jest.Mock).mockRejectedValue(new Error('nope'))
  const { result } = renderHook(() => useServers(), { wrapper })
  await waitFor(() => expect(result.current.isError).toBe(true))
})
