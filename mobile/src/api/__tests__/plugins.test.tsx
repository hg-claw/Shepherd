import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePlugins, enablePlugin, disablePlugin, savePluginConfig } from '../plugins'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

test('usePlugins resolves', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ id: 'xray', meta: { name: 'Xray', description: '', icon: '', category: 'net', host_aware: true }, enabled: true }])
  const { result } = renderHook(() => usePlugins(), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(result.current.data?.[0].id).toBe('xray')
})
test('enable/disable hit the right paths', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ enabled: true })
  await enablePlugin('xray')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/enable', { method: 'POST' })
  await disablePlugin('xray')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/disable', { method: 'POST' })
})
test('savePluginConfig PUTs the object', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await savePluginConfig('xray', { port: 443 })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/config', { method: 'PUT', body: { port: 443 } })
})
