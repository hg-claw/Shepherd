import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import LogsTab from './LogsTab'
import { pluginLogsWSURL } from '@/api/plugins'

vi.mock('@/api/plugins', () => ({
  listPluginHosts: vi.fn().mockResolvedValue([
    { id: 1, server_id: 42, plugin_id: 'singbox', status: 'running', deployed_version: '1.9.0' },
  ]),
  pluginLogsWSURL: vi.fn((pluginID: string, serverID: number) =>
    `ws://localhost/api/admin/plugins/${pluginID}/logs?server_id=${serverID}`
  ),
}))

// Minimal WebSocket stub — we only care the URL is constructed correctly.
class MockWebSocket {
  url: string
  onmessage: ((e: MessageEvent) => void) | null = null
  constructor(url: string) { this.url = url }
  close() {}
}
vi.stubGlobal('WebSocket', MockWebSocket)

describe('singbox/LogsTab', () => {
  it('constructs WS URL with singbox plugin id', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <LogsTab />
      </QueryClientProvider>,
    )
    // pluginLogsWSURL is called with 'singbox' and the server_id from the first host.
    // We verify the helper is called with correct args once a host is resolved.
    await vi.waitFor(() => {
      expect(pluginLogsWSURL).toHaveBeenCalledWith('singbox', 42)
    })
  })
})
