import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useScripts, runScript, useTargetLog } from '../scripts'
jest.mock('../authed', () => ({ authedFetch: jest.fn(), authedText: jest.fn() }))
import { authedFetch, authedText } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  ;(authedFetch as jest.Mock).mockClear()
  ;(authedText as jest.Mock).mockClear()
})

test('useScripts resolves', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ id: 1, name: 's', params: [] }])
  const { result } = renderHook(() => useScripts(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.[0].name).toBe('s')
})

test('runScript posts args + multiple targets', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ run_id: 9 })
  const r = await runScript(1, { a: 'b' }, [7, 12])
  expect(r.run_id).toBe(9)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/scripts/1/run', { method: 'POST', body: { args: { a: 'b' }, target_server_ids: [7, 12] } })
})

test('runScript filters non-finite ids (NaN from a missing route param)', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ run_id: 9 })
  await runScript(1, {}, [Number('undefined'), 7, Infinity])
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/scripts/1/run', { method: 'POST', body: { args: {}, target_server_ids: [7] } })
})

test('runScript throws when no valid target remains', () => {
  expect(() => runScript(1, {}, [NaN])).toThrow(/no target/)
  expect(() => runScript(1, {}, [])).toThrow(/no target/)
  expect(authedFetch).not.toHaveBeenCalled()
})

test('useTargetLog is disabled without a finite pty_session_id', () => {
  const { result: r1 } = renderHook(() => useTargetLog(null), { wrapper })
  const { result: r2 } = renderHook(() => useTargetLog(undefined), { wrapper })
  const { result: r3 } = renderHook(() => useTargetLog(NaN), { wrapper })
  expect(r1.current.fetchStatus).toBe('idle')
  expect(r2.current.fetchStatus).toBe('idle')
  expect(r3.current.fetchStatus).toBe('idle')
  expect(authedText).not.toHaveBeenCalled()
})

test('useTargetLog fetches the recording log when enabled', async () => {
  ;(authedText as jest.Mock).mockResolvedValue('hello from target')
  const { result } = renderHook(() => useTargetLog(42, 2000), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedText).toHaveBeenCalledWith('/api/admin/recordings/42/log')
  expect(result.current.data).toBe('hello from target')
})
