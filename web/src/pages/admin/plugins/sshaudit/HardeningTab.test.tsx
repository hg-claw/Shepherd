import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { APIError } from '@/api/client'
import HardeningTab from './HardeningTab'
import { fetchSSHAuditFail2ban, setSSHAuditFail2ban } from '@/api/sshaudit'

vi.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [{ id: 1, name: 'Server 1', ssh_host: { Valid: true, String: '1.1.1.1' } }],
  }),
}))

vi.mock('@/api/sshaudit', () => ({
  fetchSSHAuditFail2ban: vi.fn(),
  setSSHAuditFail2ban: vi.fn(),
}))

const mockStatus = fetchSSHAuditFail2ban as unknown as ReturnType<typeof vi.fn>
const mockSet = setSSHAuditFail2ban as unknown as ReturnType<typeof vi.fn>

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HardeningTab />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('sshaudit/HardeningTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders fail2ban status and the banned IP list', async () => {
    mockStatus.mockResolvedValue({
      installed: true,
      active: true,
      currently_banned: 2,
      total_banned: 9,
      banned_ips: ['198.51.100.7', '203.0.113.4'],
    })
    renderTab()
    expect(await screen.findByText('active')).toBeTruthy()
    // ban counts
    expect(screen.getByText('Currently banned')).toBeTruthy()
    expect(screen.getByText('9')).toBeTruthy()
    // banned IPs surfaced as pills
    expect(screen.getByText('198.51.100.7')).toBeTruthy()
    expect(screen.getByText('203.0.113.4')).toBeTruthy()
  })

  it('shows an offline state on a 502', async () => {
    mockStatus.mockRejectedValue(new APIError(502, 'host offline'))
    renderTab()
    expect(await screen.findByText('Host offline / no agent')).toBeTruthy()
  })

  it('shows a not-installed call-to-action and enables on click', async () => {
    mockStatus.mockResolvedValue({
      installed: false,
      active: false,
      currently_banned: 0,
      total_banned: 0,
      banned_ips: [],
    })
    mockSet.mockResolvedValue({
      installed: true,
      active: true,
      currently_banned: 0,
      total_banned: 0,
      banned_ips: [],
    })
    // Enabling is confirmed via window.confirm.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderTab()

    const enableBtn = await screen.findByText('Enable fail2ban')
    fireEvent.click(enableBtn)

    await waitFor(() => expect(mockSet).toHaveBeenCalledWith(1, true))
    expect(confirmSpy).toHaveBeenCalled()
  })

  it('does not call the API when the enable confirm is dismissed', async () => {
    mockStatus.mockResolvedValue({
      installed: false,
      active: false,
      currently_banned: 0,
      total_banned: 0,
      banned_ips: [],
    })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderTab()

    const enableBtn = await screen.findByText('Enable fail2ban')
    fireEvent.click(enableBtn)

    expect(mockSet).not.toHaveBeenCalled()
  })
})
