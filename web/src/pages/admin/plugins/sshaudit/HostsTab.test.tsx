import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import HostsTab from './HostsTab'

vi.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [
      { id: 1, name: 'Server 1', ssh_host: { Valid: true, String: '1.1.1.1' } },
      { id: 2, name: 'Server 2', ssh_host: { Valid: true, String: '2.2.2.2' } },
    ],
  }),
}))

vi.mock('@/api/sshaudit', () => ({
  listSSHAuditHosts: vi.fn().mockResolvedValue([
    { server_id: 1, enabled: true, poll_interval_seconds: 300, last_collect_at: '2026-06-16T00:00:00Z', last_error: null },
  ]),
  putSSHAuditHost: vi.fn().mockResolvedValue({ ok: true }),
  collectSSHAuditHost: vi.fn().mockResolvedValue({ ok: true, inserted: 0 }),
}))

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <HostsTab />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe('sshaudit/HostsTab', () => {
  it('renders a row per server', async () => {
    renderTab()
    expect(await screen.findByText('Server 1')).toBeTruthy()
    expect(screen.getByText('Server 2')).toBeTruthy()
  })

  it('shows a Collect now button for enabled hosts', async () => {
    renderTab()
    await screen.findByText('Server 1')
    await waitFor(() => expect(screen.getAllByText('Collect now').length).toBeGreaterThan(0))
  })
})
