import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import FileBrowserPage from './FileBrowserPage'

vi.mock('@/api/files', () => ({
  useFiles: () => ({
    data: [
      { name: 'logs', size: 0, mode: 0o755, mtime: 1700000000, is_dir: true },
      { name: 'note.txt', size: 12, mode: 0o644, mtime: 1700000000, is_dir: false },
    ],
    isLoading: false,
    refetch: vi.fn(),
  }),
  useMkdir: () => ({ mutateAsync: vi.fn() }),
  useRm: () => ({ mutateAsync: vi.fn() }),
  previewFile: vi.fn(),
  downloadFileURL: () => '#',
  uploadFile: vi.fn(),
}))

describe('FileBrowserPage', () => {
  it('renders entries', () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/admin/files/7']}>
            <Routes>
              <Route path="/admin/files/:serverId" element={<FileBrowserPage />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    expect(screen.getByText('logs')).toBeTruthy()
    expect(screen.getByText('note.txt')).toBeTruthy()
  })
})
