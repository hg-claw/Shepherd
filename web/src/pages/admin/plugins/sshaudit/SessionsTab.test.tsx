import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { APIError } from '@/api/client'
import SessionsTab from './SessionsTab'
import { fetchSSHAuditSessions } from '@/api/sshaudit'

vi.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [{ id: 1, name: 'Server 1', ssh_host: { Valid: true, String: '1.1.1.1' } }],
  }),
}))

vi.mock('@/api/sshaudit', () => ({
  fetchSSHAuditSessions: vi.fn(),
}))

const mockSessions = fetchSSHAuditSessions as unknown as ReturnType<typeof vi.fn>

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <SessionsTab />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe('sshaudit/SessionsTab', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders live sessions', async () => {
    mockSessions.mockResolvedValue({
      collected_at: '2026-06-16T00:00:00Z',
      sessions: [
        { user: 'root', source_ip: '203.0.113.9', tty: 'pts/0', login_at: '2026-06-16T00:00:00Z', pid: 4242 },
      ],
    })
    renderTab()
    expect(await screen.findByText('root')).toBeTruthy()
    expect(screen.getByText('203.0.113.9')).toBeTruthy()
  })

  it('shows an offline state on a 502', async () => {
    mockSessions.mockRejectedValue(new APIError(502, 'host offline'))
    renderTab()
    expect(await screen.findByText('Host offline / no agent')).toBeTruthy()
  })
})
