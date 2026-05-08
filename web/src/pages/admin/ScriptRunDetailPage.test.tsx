import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ScriptRunDetailPage from './ScriptRunDetailPage'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'

vi.mock('@/api/scripts', () => ({
  useScriptRunDetail: () => ({
    data: [
      { id: 1, server_id: 10, status: 'succeeded', exit_code: 0 },
    ],
    isLoading: false,
  }),
}))

vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [{ id: 10, name: 's1' }] }),
}))

describe('ScriptRunDetailPage', () => {
  it('renders target rows', () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/admin/script-runs/1']}>
            <Routes>
              <Route path="/admin/script-runs/:id" element={<ScriptRunDetailPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    expect(screen.getByText('s1')).toBeTruthy()
    expect(screen.getByText('succeeded')).toBeTruthy()
  })
})
