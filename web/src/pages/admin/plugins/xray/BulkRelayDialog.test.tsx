import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BulkRelayDialog from './BulkRelayDialog'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    createXrayInbound: vi.fn().mockResolvedValue({ id: 99 }),
    fetchXrayVersions: vi.fn().mockResolvedValue({ latest: ['1.8.11'], cached: [] }),
    generateX25519: vi.fn().mockResolvedValue({ private_key: 'priv', public_key: 'pub' }),
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

const landingInbound: pluginsAPI.XrayInbound = {
  id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', port: 443,
  role: 'landing', protocol: 'vless-reality',
  uuid: 'ul', sni: 'www.lovelive-anime.jp', public_key: 'PL', private_key: '[REDACTED]', short_id: 'aa',
  ws_path: '', ss_method: '',
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  created_at: '', updated_at: '',
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('BulkRelayDialog (inbound-level)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists target servers excluding the landing\'s own server', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={[landingInbound]} />)
    expect(screen.queryByLabelText(/select tokyo-1/)).toBeNull()  // landing's own server
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    expect(screen.getByLabelText(/select mumbai-1/)).toBeInTheDocument()
  })

  it('includes servers that already have other inbounds (multi-inbound allows it)', async () => {
    const allInbounds = [
      landingInbound,
      { ...landingInbound, id: 2, server_id: 11, tag: 'landing-bb', port: 443 },
    ]
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={allInbounds as pluginsAPI.XrayInbound[]} />)
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    // osaka-1 row shows "1 port(s) in use" hint
    expect(screen.getByText(/1 port\(s\) in use/)).toBeInTheDocument()
  })

  it('calls createXrayInbound once per selected target with role=relay + upstream_inbound_id', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingInbound} allInbounds={[landingInbound]} />)
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByLabelText(/select mumbai-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createXrayInbound).toHaveBeenCalledTimes(2)
    })
    const first = (pluginsAPI.createXrayInbound as any).mock.calls[0][0]
    expect(first.role).toBe('relay')
    expect(first.upstream_inbound_id).toBe(landingInbound.id)
    expect(first.server_id).toBe(11)  // osaka-1
  })
})
