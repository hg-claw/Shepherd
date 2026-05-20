import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TrafficTab from './TrafficTab'
import type { SingboxInbound } from '@/api/plugins'

vi.mock('@/api/plugins', () => ({
  listSingboxInbounds:      vi.fn().mockResolvedValue([
    {
      id: 1,
      server_id: 1,
      server_name: 'Server 1',
      tag: 'landing-aabb1122',
      port: 443,
      role: 'landing',
      protocol: 'vless-reality',
      created_at: '',
      updated_at: '',
    },
  ]),
  fetchSingboxTrafficBatch: vi.fn().mockResolvedValue({
    resolution: 'minute',
    series: [{
      tag: 'landing-aabb1122',
      points: [{ ts: '2026-05-20T10:00:00Z', bytes_up: 1024, bytes_down: 2048 }],
    }],
  }),
}))

vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [{ id: 1, name: 'Server 1', ssh_host: { Valid: true, String: '1.1.1.1' } }] }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/TrafficTab', () => {
  it('renders per-server section with inbound rows', async () => {
    render(<TrafficTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('Server 1')).toBeTruthy()
      expect(screen.getByText('landing-aabb1122')).toBeTruthy()
    })
  })

  it('shows time-range selector buttons', async () => {
    render(<TrafficTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('1h')).toBeTruthy()
      expect(screen.getByText('24h')).toBeTruthy()
      expect(screen.getByText('7d')).toBeTruthy()
      expect(screen.getByText('30d')).toBeTruthy()
    })
  })
})
