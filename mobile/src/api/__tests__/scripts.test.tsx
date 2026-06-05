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
