import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import TrafficDrawer from './TrafficDrawer'

// Mock the API module
vi.mock('@/api/plugins', () => ({
  fetchXrayTraffic: vi.fn().mockResolvedValue({
    server_id: 1,
    tag: 'vless-reality-8443',
    kind: 'inbound',
    resolution: 'raw',
    points: [
      { ts: '2026-05-19T10:00:00Z', bytes_up: 1024, bytes_down: 2048 },
    ],
  }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('TrafficDrawer', () => {
  it('renders tag title and time range buttons', () => {
    render(
      <TrafficDrawer
        open={true}
        onOpenChange={() => {}}
        serverID={1}
        tag="vless-reality-8443"
        kind="inbound"
      />,
      { wrapper }
    )
    expect(screen.getByText(/vless-reality-8443/)).toBeTruthy()
    expect(screen.getByText('1h')).toBeTruthy()
    expect(screen.getByText('24h')).toBeTruthy()
    expect(screen.getByText('7d')).toBeTruthy()
    expect(screen.getByText('30d')).toBeTruthy()
  })

  it('sends resolution=minute when 7d is selected', async () => {
    const { fetchXrayTraffic } = await import('@/api/plugins')
    render(
      <TrafficDrawer
        open={true}
        onOpenChange={() => {}}
        serverID={1}
        tag="vless-reality-8443"
        kind="inbound"
      />,
      { wrapper }
    )
    fireEvent.click(screen.getByText('7d'))
    // After clicking 7d, useQuery re-fetches with resolution=minute
    expect(fetchXrayTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'minute' })
    )
  })
})
