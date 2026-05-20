import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import ConfigTab from './ConfigTab'

vi.mock('@/api/plugins', () => ({
  patchSingboxServerVersion: vi.fn().mockResolvedValue({ ok: true }),
  fetchSingboxVersions: vi.fn().mockResolvedValue({
    cached: [],
    latest: ['1.11.5', '1.11.4'],
  }),
}))

vi.mock('@/api/servers', () => ({
  useServers: vi.fn().mockReturnValue({
    data: [
      { id: 1, name: 'server-1' },
      { id: 2, name: 'server-2' },
    ],
  }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/ConfigTab', () => {
  it('renders title', async () => {
    render(<ConfigTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('sing-box Binary Version')).toBeTruthy()
    })
  })

  it('displays servers with version selectors', async () => {
    render(<ConfigTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('server-1')).toBeTruthy()
      expect(screen.getByText('server-2')).toBeTruthy()
      expect(screen.getAllByText('pick version')).toBeTruthy()
      expect(screen.getAllByText('Deploy')).toBeTruthy()
    })
  })
})
