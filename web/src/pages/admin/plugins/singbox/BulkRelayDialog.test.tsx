import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BulkRelayDialog from './BulkRelayDialog'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    createSingboxInbound: vi.fn().mockResolvedValue({ id: 99 }),
    generateX25519: vi.fn().mockResolvedValue({ private_key: 'priv', public_key: 'pub12345678' }),
    generateShortID: vi.fn().mockResolvedValue({ short_id: 'sid' }),
  }
})

vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [
    { id: 10, name: 'tokyo-1', ssh_host: { Valid: true, String: '10.0.0.1' } },
    { id: 11, name: 'osaka-1', ssh_host: { Valid: true, String: '10.0.0.2' } },
    { id: 12, name: 'mumbai-1', ssh_host: { Valid: true, String: '10.0.0.3' } },
  ] }),
}))

vi.mock('@/store/ui', () => ({
  useUI: (fn: (s: { toast: () => void }) => unknown) => fn({ toast: vi.fn() }),
}))

const landingInbound: pluginsAPI.SingboxInbound = {
  id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', port: 443,
  role: 'landing', protocol: 'vless-reality',
  uuid: 'ul', sni: 'www.lovelive-anime.jp',
  reality_public_key: 'PL', reality_private_key: '[REDACTED]', reality_short_id: 'aa',
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  cert_id: null,
  created_at: '', updated_at: '',
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('singbox/BulkRelayDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('excludes the landing\'s own server from target list', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={[landingInbound]} />)
    // tokyo-1 (server_id=10) is the landing's server — should not appear
    expect(screen.queryByLabelText(/select tokyo-1/)).toBeNull()
    // Other servers should appear
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    expect(screen.getByLabelText(/select mumbai-1/)).toBeInTheDocument()
  })

  it('calls createSingboxInbound once per selected target with role=relay + upstream_inbound_id', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={[landingInbound]} />)
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createSingboxInbound).toHaveBeenCalledTimes(1)
    })
    const call = (pluginsAPI.createSingboxInbound as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.role).toBe('relay')
    expect(call.upstream_inbound_id).toBe(landingInbound.id)
    expect(call.server_id).toBe(11) // osaka-1
    expect(call.protocol).toBe('vless-reality')
  })
})
