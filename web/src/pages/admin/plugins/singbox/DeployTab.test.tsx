import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import DeployTab from './DeployTab'

const patchFn = vi.fn().mockResolvedValue({ ok: true, version: '1.11.5' })

vi.mock('@/api/plugins', () => ({
  listPluginHosts: vi.fn().mockResolvedValue([
    {
      id: 1,
      server_id: 1,
      config: {},
      deployed_version: '1.11.5',
      status: 'running',
      last_error: null,
      updated_at: '2024-01-01T00:00:00Z',
    },
    {
      id: 2,
      server_id: 2,
      config: {},
      deployed_version: '1.11.4',
      status: 'failed',
      last_error: 'binary not found at /usr/local/bin/sing-box',
      updated_at: '2024-01-02T00:00:00Z',
    },
  ]),
  fetchSingboxVersions: vi.fn().mockResolvedValue({ cached: [], latest: ['1.11.5', '1.11.4'] }),
  patchSingboxServerVersion: (...args: any[]) => patchFn(...args),
  // LifecycleButtons calls this once per row. Stub each mutation so
  // .isPending and .mutateAsync are defined; tests don't drive the
  // buttons themselves.
  useHostLifecycle: () => ({
    start:         { isPending: false, mutateAsync: vi.fn().mockResolvedValue({ status: 'running' }) },
    stop:          { isPending: false, mutateAsync: vi.fn().mockResolvedValue({ status: 'stopped' }) },
    restart:       { isPending: false, mutateAsync: vi.fn().mockResolvedValue({ status: 'running' }) },
    refreshStatus: { isPending: false, mutateAsync: vi.fn().mockResolvedValue({ status: 'running' }) },
  }),
}))

vi.mock('@/api/servers', () => ({
  useServers: vi.fn().mockReturnValue({
    data: [
      { id: 1, name: 'server-a', ssh_host: { Valid: true, String: '10.0.0.1' } },
      { id: 2, name: 'server-b', ssh_host: { Valid: false, String: '' } },
    ],
  }),
}))

vi.mock('@/store/ui', () => ({
  useUI: () => vi.fn(),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('singbox/DeployTab', () => {
  beforeEach(() => {
    patchFn.mockClear()
  })

  it('renders a row per server', async () => {
    render(<DeployTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('server-a')).toBeTruthy()
      expect(screen.getByText('server-b')).toBeTruthy()
    })
  })

  it('shows running status pill for running host', async () => {
    render(<DeployTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('running')).toBeTruthy()
    })
  })

  it('shows failed status pill for failed host', async () => {
    render(<DeployTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('failed')).toBeTruthy()
    })
  })

  it('shows "see error" tooltip for failed host with last_error', async () => {
    render(<DeployTab />, { wrapper })
    await waitFor(() => {
      const errEl = screen.getByText('see error')
      expect(errEl).toBeTruthy()
      expect(errEl.getAttribute('title')).toContain('binary not found')
    })
  })

  it('shows ssh_host under server name when valid', async () => {
    render(<DeployTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('10.0.0.1')).toBeTruthy()
    })
  })

  it('clicking Re-deploy calls patchSingboxServerVersion with current version', async () => {
    const user = userEvent.setup()
    render(<DeployTab />, { wrapper })
    const btns = await screen.findAllByText('Re-deploy')
    await user.click(btns[0])
    await waitFor(() => {
      expect(patchFn).toHaveBeenCalledWith(1, '1.11.5')
    })
  })
})
