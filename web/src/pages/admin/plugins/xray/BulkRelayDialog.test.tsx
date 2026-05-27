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

vi.mock('@/store/ui', () => ({
  useUI: (fn: (s: { toast: () => void }) => unknown) => fn({ toast: vi.fn() }),
}))

const landingVlessReality: pluginsAPI.XrayInbound = {
  id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', alias: '', port: 443,
  role: 'landing', protocol: 'vless-reality',
  uuid: 'ul', sni: 'www.lovelive-anime.jp', public_key: 'PL', private_key: '[REDACTED]', short_id: 'aa',
  ws_path: '', ss_method: '',
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  created_at: '', updated_at: '',
}

const landingVmessWs: pluginsAPI.XrayInbound = {
  id: 2, server_id: 10, server_name: 'tokyo-1', tag: 'landing-bb', alias: '', port: 80,
  role: 'landing', protocol: 'vmess-ws',
  uuid: 'vmess-uuid', sni: '', public_key: '', private_key: '', short_id: '',
  ws_path: '/ws',
  ss_method: '',
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  created_at: '', updated_at: '',
}

const landingShadowsocks: pluginsAPI.XrayInbound = {
  id: 3, server_id: 10, server_name: 'tokyo-1', tag: 'landing-cc', alias: '', port: 8388,
  role: 'landing', protocol: 'shadowsocks',
  uuid: '', sni: '', public_key: '', private_key: '', short_id: '',
  ws_path: '', ss_method: 'aes-256-gcm',
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
      landingInbound={landingVlessReality} allInbounds={[landingVlessReality]} />)
    expect(screen.queryByLabelText(/select tokyo-1/)).toBeNull()  // landing's own server
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    expect(screen.getByLabelText(/select mumbai-1/)).toBeInTheDocument()
  })

  it('includes servers that already have other inbounds (multi-inbound allows it)', async () => {
    const allInbounds = [
      landingVlessReality,
      { ...landingVlessReality, id: 2, server_id: 11, tag: 'landing-bb', port: 443 },
    ]
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingVlessReality} allInbounds={allInbounds as pluginsAPI.XrayInbound[]} />)
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    // osaka-1 row shows "1 port(s) in use" hint
    expect(screen.getByText(/1 port\(s\) in use/)).toBeInTheDocument()
  })

  it('calls createXrayInbound once per selected target with role=relay + upstream_inbound_id (vless-reality)', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingVlessReality} allInbounds={[landingVlessReality]} />)
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByLabelText(/select mumbai-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createXrayInbound).toHaveBeenCalledTimes(2)
    })
    const first = (pluginsAPI.createXrayInbound as any).mock.calls[0][0]
    expect(first.role).toBe('relay')
    expect(first.upstream_inbound_id).toBe(landingVlessReality.id)
    expect(first.server_id).toBe(11)  // osaka-1
    expect(first.protocol).toBe('vless-reality')
  })

  it('calls createXrayInbound with new uuid + ws_path for vmess-ws', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingVmessWs} allInbounds={[landingVmessWs]} />)
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createXrayInbound).toHaveBeenCalledTimes(1)
    })
    const call = (pluginsAPI.createXrayInbound as any).mock.calls[0][0]
    expect(call.role).toBe('relay')
    expect(call.protocol).toBe('vmess-ws')
    expect(call.upstream_inbound_id).toBe(landingVmessWs.id)
    expect(typeof call.uuid).toBe('string')
    expect(call.uuid).not.toBe(landingVmessWs.uuid)
    expect(call.ws_path).toBe('/ws')
    // should NOT have any reality keys
    expect(call.public_key).toBeUndefined()
    expect(call.private_key).toBeUndefined()
  })

  it('calls createXrayInbound with new ss_password + method for shadowsocks', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingShadowsocks} allInbounds={[landingShadowsocks]} />)
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createXrayInbound).toHaveBeenCalledTimes(1)
    })
    const call = (pluginsAPI.createXrayInbound as any).mock.calls[0][0]
    expect(call.role).toBe('relay')
    expect(call.protocol).toBe('shadowsocks')
    expect(call.upstream_inbound_id).toBe(landingShadowsocks.id)
    expect(call.ss_method).toBe('aes-256-gcm')
    expect(typeof call.ss_password).toBe('string')
    expect(call.ss_password.length).toBeGreaterThan(0)
  })
})
