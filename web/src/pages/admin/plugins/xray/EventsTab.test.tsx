import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import EventsTab from './EventsTab'

vi.mock('@/api/plugins', () => ({
  listPluginEvents: () => Promise.resolve([
    { ts: '2026-05-16T08:14:01Z', admin_id: 1, server_id: 7,
      action: 'plugin.xray.host.deployed', result: 'ok', details: { version: '1.8.11' } },
    { ts: '2026-05-16T07:50:00Z', admin_id: 1, server_id: null,
      action: 'plugin.xray.binary.downloaded', result: 'ok', details: { version: '1.8.11' } },
  ]),
}))

describe('xray EventsTab', () => {
  it('renders events rows', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter><EventsTab /></MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('plugin.xray.host.deployed')).toBeTruthy()
    expect(screen.getByText('plugin.xray.binary.downloaded')).toBeTruthy()
  })
})
