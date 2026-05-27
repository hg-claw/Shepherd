import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundDialog from './InboundDialog'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    createXrayInbound: vi.fn().mockResolvedValue({ id: 99 }),
    patchXrayInbound: vi.fn().mockResolvedValue({ id: 1 }),
    generateX25519: vi.fn().mockResolvedValue({ private_key: 'priv', public_key: 'pub' }),
    generateShortID: vi.fn().mockResolvedValue({ short_id: 'sid' }),
  }
})
vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [
    { id: 10, name: 'tokyo-1', ssh_host: { Valid: true, String: '10.0.0.1' } },
    { id: 11, name: 'osaka-1', ssh_host: { Valid: true, String: '10.0.0.2' } },
  ] }),
}))

const landing: pluginsAPI.XrayInbound = {
  id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', alias: '', port: 443,
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

describe('InboundDialog (create)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('relay role shows upstream selector with landings only', async () => {
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="create"
      allInbounds={[landing]} />)
    // Select role=relay
    const roleSelect = await screen.findByLabelText(/role/i) as HTMLSelectElement
    fireEvent.change(roleSelect, { target: { value: 'relay' } })
    const upstreamSelect = await screen.findByLabelText(/upstream landing-inbound/i) as HTMLSelectElement
    const opts = Array.from(upstreamSelect.options).map((o) => o.value)
    expect(opts).toContain(String(landing.id))
  })

  it('submits POST /inbounds with the right body', async () => {
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="create"
      defaultServerID={11} allInbounds={[landing]} />)
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    await waitFor(() => {
      expect(pluginsAPI.createXrayInbound).toHaveBeenCalled()
    })
    const body = (pluginsAPI.createXrayInbound as any).mock.calls[0][0]
    expect(body.server_id).toBe(11)
    expect(body.role).toBe('landing')
  })

  it('alias input renders and is submitted on create', async () => {
    const spy = vi.spyOn(pluginsAPI, 'createXrayInbound')
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="create"
      defaultServerID={11} allInbounds={[landing]} />)
    const aliasInput = screen.getByLabelText(/alias/i)
    fireEvent.change(aliasInput, { target: { value: 'my-node' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    await waitFor(() => {
      expect(spy).toHaveBeenCalled()
    })
    const body = spy.mock.calls[0][0]
    expect(body).toMatchObject({ alias: 'my-node' })
  })
})

describe('InboundDialog (edit)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('role, server, upstream and protocol are disabled in edit mode', async () => {
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="edit"
      inbound={landing} allInbounds={[landing]} />)
    const roleSelect = await screen.findByLabelText(/role/i) as HTMLSelectElement
    expect(roleSelect.disabled).toBe(true)
    const serverSelect = screen.getByLabelText(/server/i) as HTMLSelectElement
    expect(serverSelect.disabled).toBe(true)
  })

  it('editing a vless-reality inbound does NOT send ss_method in patch body', async () => {
    const spy = vi.spyOn(pluginsAPI, 'patchXrayInbound').mockResolvedValue({} as never)
    // landing fixture has ss_method: '' and protocol: 'vless-reality'
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="edit"
      inbound={landing} allInbounds={[landing]} />)
    // Click Save without changing anything
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    const patchBody = spy.mock.calls[0][1]
    expect(patchBody.ss_method).toBeUndefined()
    expect(patchBody.ss_password).toBeUndefined()
  })
})

describe('InboundDialog (shadowsocks)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('shadowsocks: renders method+password and submits ss_* on create', async () => {
    const create = vi.spyOn(pluginsAPI, 'createXrayInbound').mockResolvedValue({} as never)
    wrap(<InboundDialog open={true} onOpenChange={() => {}} mode="create"
      defaultServerID={11} allInbounds={[landing]} />)
    // switch protocol to shadowsocks
    const protocolSelect = screen.getByDisplayValue('VLESS + REALITY')
    fireEvent.change(protocolSelect, { target: { value: 'shadowsocks' } })
    // method and password fields should now be visible
    expect(screen.getByLabelText(/method/i)).toBeInTheDocument()
    // click the 'new' button to fill the SS password
    fireEvent.click(screen.getByRole('button', { name: /^new$/i }))
    // submit
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    await waitFor(() => expect(create).toHaveBeenCalled())
    const body = create.mock.calls[0][0]
    expect(body).toMatchObject({ protocol: 'shadowsocks' })
    expect(typeof body.ss_method).toBe('string')
    expect((body.ss_password as string).length).toBeGreaterThan(0)
  })
})
