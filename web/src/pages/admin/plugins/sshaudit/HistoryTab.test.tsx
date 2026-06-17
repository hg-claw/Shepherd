import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import HistoryTab from './HistoryTab'
import { fetchSSHAuditSummary, fetchSSHAuditEvents } from '@/api/sshaudit'

vi.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [{ id: 1, name: 'Server 1', ssh_host: { Valid: true, String: '1.1.1.1' } }],
  }),
}))

vi.mock('@/api/sshaudit', () => ({
  fetchSSHAuditSummary: vi.fn().mockResolvedValue({
    window_hours: 24,
    accepted: 12,
    failed: 34,
    unique_source_ips: 5,
    top_sources: [{ source_ip: '198.51.100.7', count: 20, last_ts: '2026-06-16T00:00:00Z' }],
    top_failed_users: [{ username: 'admin', count: 9 }],
  }),
  fetchSSHAuditEvents: vi.fn().mockResolvedValue([
    { id: 2, ts: '2026-06-16T00:01:00Z', result: 'failed', method: 'password', invalid_user: true, username: 'oracle', source_ip: '198.51.100.7', port: 41122 },
    { id: 1, ts: '2026-06-16T00:00:00Z', result: 'accepted', method: 'publickey', invalid_user: false, username: 'deploy', source_ip: '203.0.113.4', port: 51234 },
  ]),
}))

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HistoryTab />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const mockSummary = fetchSSHAuditSummary as unknown as ReturnType<typeof vi.fn>
const mockEvents = fetchSSHAuditEvents as unknown as ReturnType<typeof vi.fn>

describe('sshaudit/HistoryTab', () => {
  it('renders the summary strip and event rows', async () => {
    renderTab()
    // events table
    expect(await screen.findByText('oracle')).toBeTruthy()
    expect(screen.getByText('deploy')).toBeTruthy()
    // invalid-user badge on the failed row
    expect(screen.getByText('invalid')).toBeTruthy()
    // summary top source (also appears as a source IP in the events table)
    expect(screen.getAllByText('198.51.100.7').length).toBeGreaterThan(0)
    // failed counts in the summary strip
    expect(screen.getByText('34')).toBeTruthy()
  })

  it('defaults to the 24h window', async () => {
    mockSummary.mockClear()
    mockEvents.mockClear()
    renderTab()
    await screen.findByText('oracle')
    expect(mockSummary).toHaveBeenCalledWith(1, { window: '24h' })
    expect(mockEvents).toHaveBeenCalledWith(1, { result: 'all', limit: 200, window: '24h' })
  })

  it('switching the window refetches summary + events with the new window', async () => {
    mockSummary.mockClear()
    mockEvents.mockClear()
    renderTab()
    await screen.findByText('oracle')

    fireEvent.click(screen.getByText('7d'))

    await waitFor(() => expect(mockSummary).toHaveBeenCalledWith(1, { window: '7d' }))
    expect(mockEvents).toHaveBeenCalledWith(1, { result: 'all', limit: 200, window: '7d' })
  })
})
