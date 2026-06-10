import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useTelemetrySeries } from '../metrics'

jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

test('useTelemetrySeries hits the range endpoint and resolves points', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([
    { ts: '2026-06-09T00:00:00Z', cpu_pct: 12.5, net_rx_bps: 1000 },
  ])
  const { result } = renderHook(() => useTelemetrySeries(7, '24h'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/servers/7/telemetry?range=24h')
  expect(result.current.data?.[0].cpu_pct).toBe(12.5)
})

test('useTelemetrySeries surfaces error', async () => {
  ;(authedFetch as jest.Mock).mockRejectedValue(new Error('nope'))
  const { result } = renderHook(() => useTelemetrySeries(7, '1h'), { wrapper })
  await waitFor(() => expect(result.current.isError).toBe(true))
})
