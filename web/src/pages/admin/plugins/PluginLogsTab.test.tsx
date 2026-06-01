// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { renderWithProviders } from '@/test-utils/render'

class FakeWS {
  static instances: FakeWS[] = []
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  close = vi.fn()
  constructor() { FakeWS.instances.push(this) }
}
vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)

vi.mock('@/api/plugins', async (orig) => {
  const actual = await orig<typeof import('@/api/plugins')>()
  return {
    ...actual,
    listPluginHosts: vi.fn().mockResolvedValue([{ id: 1, server_id: 9 }]),
    pluginLogsWSURL: (plugin: string, id: number) => `ws://x/${plugin}/${id}`,
  }
})

import { PluginLogsTab } from './PluginLogsTab'

const send = (line: string) =>
  act(() => FakeWS.instances.at(-1)!.onmessage?.({ data: JSON.stringify({ ts: '2026-01-01T00:00:01Z', level: 'info', line }) }))

beforeEach(() => { FakeWS.instances = [] })

describe('PluginLogsTab pause', () => {
  it('pause keeps the buffer and does not reconnect; resume keeps appending', async () => {
    renderWithProviders(<PluginLogsTab plugin="xray" />)
    // Wait for the hosts query to resolve → serverID effect → WS open. Polling
    // (not a fixed microtask count) keeps this deterministic in isolation too.
    await waitFor(() => expect(FakeWS.instances.length).toBe(1))

    send('line-A')
    expect(screen.getByText('line-A')).toBeTruthy()

    fireEvent.click(screen.getByText('Pause'))
    expect(FakeWS.instances.length).toBe(1)
    expect(screen.getByText('line-A')).toBeTruthy()
    send('line-B')
    expect(screen.queryByText('line-B')).toBeNull()
    expect(screen.getByText('line-A')).toBeTruthy()

    fireEvent.click(screen.getByText('Resume'))
    send('line-C')
    expect(screen.getByText('line-C')).toBeTruthy()
    expect(screen.getByText('line-A')).toBeTruthy()
  })
})
