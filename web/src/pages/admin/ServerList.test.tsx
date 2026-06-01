// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { renderWithProviders } from '@/test-utils/render'

const navigate = vi.fn()
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

vi.mock('@/api/servers', async (orig) => {
  const actual = await orig<typeof import('@/api/servers')>()
  return {
    ...actual,
    useServers: () => ({
      data: [{
        id: 7,
        name: 'srv7',
        show_on_public: false,
        connected: true,
        install_stage: 'done',
        agent_last_seen: { Valid: true, Time: new Date().toISOString() },
        latest: null,
      }],
      isLoading: false,
    }),
    useDeleteServer: () => ({ mutate: vi.fn(), isPending: false }),
    useBatchUpdateAgent: () => ({ mutate: vi.fn(), isPending: false }),
    useReinstall: () => ({ mutate: vi.fn(), isPending: false }),
  }
})

beforeEach(() => navigate.mockClear())

describe('ServerList row navigation', () => {
  it('navigates client-side on row click (no full reload)', async () => {
    const { default: ServerList } = await import('./ServerList')
    renderWithProviders(<ServerList />)
    // The server name link has stopPropagation; click the containing <tr> directly.
    const nameLink = await screen.findByText('srv7')
    const row = nameLink.closest('tr')!
    fireEvent.click(row)
    expect(navigate).toHaveBeenCalledWith('/admin/servers/7')
  })
})
