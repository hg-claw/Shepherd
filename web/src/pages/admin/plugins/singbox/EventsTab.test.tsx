import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import EventsTab from './EventsTab'

vi.mock('@/api/plugins', () => ({
  listPluginEvents: () => Promise.resolve([
    { ts: '2026-05-16T08:14:01Z', admin_id: 1, server_id: 7,
      action: 'plugin.singbox.host.deployed', result: 'ok', details: { version: '1.9.0' } },
    { ts: '2026-05-16T07:50:00Z', admin_id: 1, server_id: null,
      action: 'plugin.singbox.binary.downloaded', result: 'err', details: {} },
  ]),
}))

describe('singbox/EventsTab', () => {
  it('renders event rows', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <EventsTab />
      </QueryClientProvider>,
    )
    expect(await screen.findByText('plugin.singbox.host.deployed')).toBeTruthy()
    expect(screen.getByText('plugin.singbox.binary.downloaded')).toBeTruthy()
  })
})
