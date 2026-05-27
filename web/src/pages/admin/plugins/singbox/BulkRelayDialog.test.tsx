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

const landingVlessReality: pluginsAPI.SingboxInbound = {
  id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', alias: '', port: 443,
  role: 'landing', protocol: 'vless-reality',
  uuid: 'ul', sni: 'www.lovelive-anime.jp',
  reality_public_key: 'PL', reality_private_key: '[REDACTED]', reality_short_id: 'aa',
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  cert_id: null,
  created_at: '', updated_at: '',
}

const landingTrojanTLS: pluginsAPI.SingboxInbound = {
  id: 2, server_id: 10, server_name: 'tokyo-1', tag: 'landing-bb', alias: '', port: 443,
  role: 'landing', protocol: 'trojan-tls',
  password: 'landing-pass', sni: 'example.com', cert_id: 7,
  upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
  created_at: '', updated_at: '',
}

const landingShadowsocks: pluginsAPI.SingboxInbound = {
  id: 3, server_id: 10, server_name: 'tokyo-1', tag: 'landing-cc', alias: '', port: 8388,
  role: 'landing', protocol: 'shadowsocks-2022',
  ss_method: '2022-blake3-aes-128-gcm', ss_password: 'some-password',
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
      landingInbound={landingVlessReality} allInbounds={[landingVlessReality]} />)
    // tokyo-1 (server_id=10) is the landing's server — should not appear
    expect(screen.queryByLabelText(/select tokyo-1/)).toBeNull()
    // Other servers should appear
    expect(await screen.findByLabelText(/select osaka-1/)).toBeInTheDocument()
    expect(screen.getByLabelText(/select mumbai-1/)).toBeInTheDocument()
  })

  it('calls createSingboxInbound with role=relay + upstream_inbound_id for vless-reality', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingVlessReality} allInbounds={[landingVlessReality]} />)
    // The dialog now defaults to "forward" mode (transparent NAT, no
    // per-relay keys). These older tests assert the legacy proxy-mode
    // body shape, so flip to "Proxy" first.
    fireEvent.click(await screen.findByRole('button', { name: /proxy.*per-relay/i }))
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createSingboxInbound).toHaveBeenCalledTimes(1)
    })
    const call = (pluginsAPI.createSingboxInbound as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.role).toBe('relay')
    expect(call.upstream_inbound_id).toBe(landingVlessReality.id)
    expect(call.server_id).toBe(11) // osaka-1
    expect(call.protocol).toBe('vless-reality')
    // reality_public_key is populated via eager-fill loop (the dialog calls regenKeys before
    // the user clicks Deploy when keys are missing); the actual value may vary.
    expect(call.reality_public_key).toBeDefined()
  })

  it('calls createSingboxInbound with password for trojan-tls, inheriting sni + cert_id', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingTrojanTLS} allInbounds={[landingTrojanTLS]} />)
    // The dialog now defaults to "forward" mode (transparent NAT, no
    // per-relay keys). These older tests assert the legacy proxy-mode
    // body shape, so flip to "Proxy" first.
    fireEvent.click(await screen.findByRole('button', { name: /proxy.*per-relay/i }))
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createSingboxInbound).toHaveBeenCalledTimes(1)
    })
    const call = (pluginsAPI.createSingboxInbound as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.role).toBe('relay')
    expect(call.protocol).toBe('trojan-tls')
    expect(call.upstream_inbound_id).toBe(landingTrojanTLS.id)
    expect(call.sni).toBe('example.com')
    expect(call.cert_id).toBe(7)
    expect(typeof call.password).toBe('string')
    expect(call.password).not.toBe(landingTrojanTLS.password) // relay gets own password
    // should NOT have any reality keys
    expect(call.reality_public_key).toBeUndefined()
    expect(call.uuid).toBeUndefined()
  })

  it('forward mode (default): sends only port+role+protocol+upstream+relay_mode, no keys', async () => {
    // New default. Forward relays don't have per-row credentials at
    // all — the server renders a direct inbound that NATs to the
    // landing. Confirm the body is minimal.
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingVlessReality} allInbounds={[landingVlessReality]} />)
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createSingboxInbound).toHaveBeenCalledTimes(1)
    })
    const call = (pluginsAPI.createSingboxInbound as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.relay_mode).toBe('forward')
    expect(call.role).toBe('relay')
    expect(call.upstream_inbound_id).toBe(landingVlessReality.id)
    expect(call.protocol).toBe('vless-reality')
    // Forward relays must not carry credentials.
    expect(call.uuid).toBeUndefined()
    expect(call.reality_public_key).toBeUndefined()
    expect(call.reality_private_key).toBeUndefined()
    expect(call.reality_short_id).toBeUndefined()
    expect(call.sni).toBeUndefined()
    expect(call.password).toBeUndefined()
    expect(call.ss_password).toBeUndefined()
  })

  it('calls createSingboxInbound with new ss_password for shadowsocks-2022, inheriting ss_method', async () => {
    wrap(<BulkRelayDialog open={true} onOpenChange={() => {}}
      landingInbound={landingShadowsocks} allInbounds={[landingShadowsocks]} />)
    // The dialog now defaults to "forward" mode (transparent NAT, no
    // per-relay keys). These older tests assert the legacy proxy-mode
    // body shape, so flip to "Proxy" first.
    fireEvent.click(await screen.findByRole('button', { name: /proxy.*per-relay/i }))
    fireEvent.click(await screen.findByLabelText(/select osaka-1/))
    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))
    await waitFor(() => {
      expect(pluginsAPI.createSingboxInbound).toHaveBeenCalledTimes(1)
    })
    const call = (pluginsAPI.createSingboxInbound as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(call.role).toBe('relay')
    expect(call.protocol).toBe('shadowsocks-2022')
    expect(call.upstream_inbound_id).toBe(landingShadowsocks.id)
    expect(call.ss_method).toBe('2022-blake3-aes-128-gcm')
    expect(typeof call.ss_password).toBe('string')
    expect(call.ss_password).not.toBe(landingShadowsocks.ss_password)
  })
})
