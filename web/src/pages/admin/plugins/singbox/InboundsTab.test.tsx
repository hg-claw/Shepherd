import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundsTab from './InboundsTab'

vi.mock('@/api/servers', () => ({
  useServers: () => ({
    data: [
      { id: 1, name: 'Server 1', ssh_host: { Valid: true, String: '1.1.1.1' } },
      { id: 2, name: 'Server 2', ssh_host: { Valid: true, String: '2.2.2.2' } },
    ],
  }),
}))

vi.mock('@/api/plugins', () => ({
  listSingboxInbounds: vi.fn().mockResolvedValue([
    {
      id: 1, server_id: 1, server_name: 'Server 1', tag: 'landing-aabb1122', port: 443,
      role: 'landing', protocol: 'vless-reality',
      uuid: 'uuid-1', sni: 'www.icloud.com',
      reality_public_key: 'pubk', reality_private_key: '[REDACTED]',
      reality_short_id: 'aabb1122',
      upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
      cert_id: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 2, server_id: 2, server_name: 'Server 2', tag: 'relay-ccdd3344', port: 8443,
      role: 'relay', protocol: 'vless-reality',
      upstream_inbound_id: 1, upstream_tag: 'landing-aabb1122', upstream_server_id: 1, upstream_server_name: 'Server 1',
      cert_id: null,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    },
  ]),
  deleteSingboxInbound: vi.fn().mockResolvedValue(undefined),
  fetchSingboxTrafficBatch: vi.fn().mockResolvedValue({ resolution: 'raw', series: [] }),
  patchSingboxServerVersion: vi.fn().mockResolvedValue({ ok: true }),
  listPluginHosts: vi.fn().mockResolvedValue([]),
}))

vi.mock('@/store/ui', () => ({
  useUI: (fn: (s: { toast: () => void }) => unknown) => fn({ toast: vi.fn() }),
}))

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('singbox/InboundsTab', () => {
  it('groups inbounds by server', async () => {
    wrap(<InboundsTab />)
    await waitFor(() => {
      expect(screen.getByText('Server 1')).toBeTruthy()
      expect(screen.getByText('Server 2')).toBeTruthy()
      expect(screen.getByText('landing-aabb1122')).toBeTruthy()
      expect(screen.getByText('relay-ccdd3344')).toBeTruthy()
    })
  })

  it('shows active/idle dot per inbound row', async () => {
    wrap(<InboundsTab />)
    const row = (await screen.findByText('landing-aabb1122')).closest('tr')!
    expect(row.querySelector('span[title*="active"], span[title*="idle"]')).toBeTruthy()
  })

  it('disables delete for landing with dependent relay', async () => {
    wrap(<InboundsTab />)
    const landingRow = (await screen.findByText('landing-aabb1122')).closest('tr')!
    const delBtn = landingRow.querySelector('button[title*="depend"]') as HTMLButtonElement | null
    expect(delBtn?.disabled).toBe(true)
  })
})
