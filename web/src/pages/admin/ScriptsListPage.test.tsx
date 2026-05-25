import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ScriptsListPage from './ScriptsListPage'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

vi.mock('@/api/scripts', () => ({
  useScripts: () => ({ data: [{ id: 1, name: 'uptime', description: '', content: '', params: [] }], isLoading: false }),
  useDeleteScript: () => ({ mutate: vi.fn() }),
  useScriptRuns: () => ({
    data: [{ id: 7, script_id: 1, started_at: '2026-05-25T10:00:00Z', finished_at: '2026-05-25T10:00:05Z' }],
  }),
  // Expanding a run row drives this — the bug was that the row flipped its
  // chevron but rendered no detail. Asserting the target shows up proves
  // the expanded content is wired.
  useScriptRunDetail: () => ({
    data: [{ id: 99, server_id: 10, status: 'succeeded', exit_code: 0 }],
    isLoading: false,
  }),
}))

vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [{ id: 10, name: 'web-1' }] }),
}))

function renderPage() {
  const qc = new QueryClient()
  render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <ScriptsListPage />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe('ScriptsListPage recent runs', () => {
  it('expanding a run row reveals its per-server targets', async () => {
    renderPage()
    // Target server name not visible until the row is expanded.
    expect(screen.queryByText('web-1')).toBeNull()

    // Click a plain cell on the row (the started_at timestamp) — the run-id
    // link stops propagation, but the rest of the row toggles expansion.
    fireEvent.click(screen.getByText('2026-05-25T10:00:00Z'))

    await waitFor(() => {
      expect(screen.getByText('web-1')).toBeTruthy()
    })
  })
})
