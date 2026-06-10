import React from 'react'
import { renderHook, waitFor } from '@testing-library/react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  useInbounds, listInbounds, createInbound, patchInbound, deleteInbound, DeleteInboundConflict,
  generateX25519, generateShortID,
  buildSingboxShareURL, buildXrayShareURL, shareURLFor,
  SINGBOX_URL_PROTOCOLS, XRAY_URL_PROTOCOLS,
  needsUUID, needsPassword, needsReality, needsCertAndSNI, needsTransport, needsSS,
  singboxCreatableOnMobile, randomUUID, randomPort, randomPassword, randomSSKey,
  type ProxyInboundFull,
} from '../inbounds'

jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

// deleteInbound does its own fetch (to recover relay_inbound_ids), so it reads
// the auth store + global fetch directly.
jest.mock('../../store/auth', () => ({
  useAuth: { getState: () => ({ baseURL: 'https://h.example', token: 'tok', clearSession: jest.fn() }) },
}))

const wrapper = ({ children }: { children: React.ReactNode }) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => { (authedFetch as jest.Mock).mockReset() })

// ── list / create / patch URLs + params ────────────────────────────────────────

test('listInbounds hits the plugin-keyed path; server_id is appended when given', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([])
  await listInbounds('singbox')
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/singbox/inbounds')
  await listInbounds('xray', 7)
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/xray/inbounds?server_id=7')
})

test('useInbounds keys by plugin and resolves the widened rows', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([
    { id: 1, server_id: 7, server_name: 'a', tag: 'vless-reality-8443', alias: '', port: 8443, role: 'landing', protocol: 'vless-reality' },
  ])
  const { result } = renderHook(() => useInbounds('xray'), { wrapper })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/inbounds')
  expect(result.current.data?.[0].tag).toBe('vless-reality-8443')
})

test('createInbound POSTs to the plugin path and never includes a tag', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ id: 9 })
  await createInbound('singbox', { server_id: 7, port: 8443, role: 'landing', protocol: 'vless-reality', uuid: 'u' })
  const [path, opts] = (authedFetch as jest.Mock).mock.calls[0]
  expect(path).toBe('/api/admin/plugins/singbox/inbounds')
  expect(opts.method).toBe('POST')
  expect(opts.body).not.toHaveProperty('tag')
  expect(opts.body).toMatchObject({ server_id: 7, port: 8443, role: 'landing', protocol: 'vless-reality' })
})

test('patchInbound PATCHes /{id} with exactly the provided keys', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ id: 9 })
  await patchInbound('xray', 9, { port: 443, alias: 'edge' })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/inbounds/9', { method: 'PATCH', body: { port: 443, alias: 'edge' } })
})

test('REALITY keygen + short-id call the shared XRAY namespace with an empty body', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValueOnce({ private_key: 'priv', public_key: 'pub' })
  await generateX25519()
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/xray/keys/x25519', { method: 'POST', body: {} })
  ;(authedFetch as jest.Mock).mockResolvedValueOnce({ short_id: 'abcd' })
  await generateShortID()
  expect(authedFetch).toHaveBeenLastCalledWith('/api/admin/plugins/xray/keys/short-id', { method: 'POST', body: {} })
})

// ── delete: 204 / 200 / 409 with relay_inbound_ids ─────────────────────────────

test('deleteInbound resolves on a 204 (sing-box) with no body', async () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, json: async () => { throw new Error('empty') } })
  ;(global as unknown as { fetch: jest.Mock }).fetch = fetchMock
  await expect(deleteInbound('singbox', 5)).resolves.toBeUndefined()
  expect(fetchMock).toHaveBeenCalledWith(
    'https://h.example/api/admin/plugins/singbox/inbounds/5',
    expect.objectContaining({ method: 'DELETE' }),
  )
})

test('deleteInbound resolves on xray 200 {ok:true}', async () => {
  ;(global as unknown as { fetch: jest.Mock }).fetch =
    jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
  await expect(deleteInbound('xray', 3)).resolves.toBeUndefined()
})

test('deleteInbound throws DeleteInboundConflict carrying relay_inbound_ids on 409', async () => {
  ;(global as unknown as { fetch: jest.Mock }).fetch = jest.fn().mockResolvedValue({
    ok: false, status: 409,
    json: async () => ({ error: 'landing has relays', relay_inbound_ids: [11, 12] }),
  })
  await expect(deleteInbound('singbox', 1)).rejects.toMatchObject({
    name: 'DeleteInboundConflict',
    message: 'landing has relays',
    relayInboundIDs: [11, 12],
  })
  // the typed guard works
  const err = await deleteInbound('singbox', 1).catch((e) => e)
  expect(err).toBeInstanceOf(DeleteInboundConflict)
})

// ── wire-shape gotchas: unwrapped upstream + present-but-null pointers ──────────

test('upstream_* arrive as bare values or absent (handler-unwrapped, NOT sql.Null objects)', () => {
  // A relay row: upstream_tag/server_name are plain strings, upstream_inbound_id a number.
  const relay: ProxyInboundFull = {
    id: 2, server_id: 9, server_name: 'b', tag: 'relay-1234', alias: '', port: 1234, role: 'relay', protocol: 'vless-reality',
    upstream_inbound_id: 1, upstream_tag: 'vless-reality-8443', upstream_server_id: 7, upstream_server_name: 'a',
    relay_mode: 'forward',
  }
  // read directly — no {String,Valid} unwrap needed
  expect(relay.upstream_tag).toBe('vless-reality-8443')
  expect(relay.upstream_server_name).toBe('a')
  // a landing row simply omits them
  const landing: ProxyInboundFull = {
    id: 1, server_id: 7, server_name: 'a', tag: 'vless-reality-8443', alias: '', port: 8443, role: 'landing', protocol: 'vless-reality',
    cert_id: null, // *int64 present-but-null
  }
  expect(landing.upstream_tag).toBeUndefined()
  expect(landing.cert_id).toBeNull()
})

// ── share-URL builders (ported from web) ───────────────────────────────────────

const REALITY: ProxyInboundFull = {
  id: 1, server_id: 7, server_name: 'edge', tag: 'vless-reality-8443', alias: '', port: 8443,
  role: 'landing', protocol: 'vless-reality',
  uuid: 'uuid-1', sni: 'www.cloudflare.com', reality_public_key: 'PUBKEY', reality_short_id: 'aa11',
}

test('singbox vless-reality URL carries uuid/host/port + reality params', () => {
  const url = buildSingboxShareURL(REALITY, 'edge.example.com')!
  expect(url.startsWith('vless://uuid-1@edge.example.com:8443?')).toBe(true)
  expect(url).toContain('security=reality')
  expect(url).toContain('pbk=PUBKEY')
  expect(url).toContain('sid=aa11')
  expect(url).toContain('sni=www.cloudflare.com')
  expect(url.endsWith('#edge%2Fvless-reality-8443')).toBe(true)
})

test('singbox builder returns null when required secrets are missing/redacted', () => {
  expect(buildSingboxShareURL({ ...REALITY, reality_public_key: undefined }, 'edge.example.com')).toBeNull()
  expect(buildSingboxShareURL(REALITY, '')).toBeNull() // no hostname
})

test('singbox vmess + shadowsocks use base64 (no global btoa needed)', () => {
  const vmess = buildSingboxShareURL(
    { ...REALITY, protocol: 'vmess-ws-tls', transport_path: '/p', transport_host: 'h', alter_id: 0 },
    'edge.example.com',
  )!
  expect(vmess.startsWith('vmess://')).toBe(true)
  // decode the base64 payload back to JSON
  const json = JSON.parse(Buffer.from(vmess.slice('vmess://'.length), 'base64').toString('utf8'))
  expect(json).toMatchObject({ add: 'edge.example.com', port: '8443', id: 'uuid-1', net: 'ws', tls: 'tls' })

  const ss = buildSingboxShareURL(
    { ...REALITY, protocol: 'shadowsocks-2022', ss_method: '2022-blake3-aes-128-gcm', password: 'KEY==' },
    'edge.example.com',
  )!
  expect(ss.startsWith('ss://')).toBe(true)
  expect(ss).toContain('@edge.example.com:8443')
})

test('singbox trojan / hysteria2 / tuic / anytls builders', () => {
  const base = { ...REALITY, password: 'pw/with+special' }
  const trojan = buildSingboxShareURL({ ...base, protocol: 'trojan-tls' }, 'h')!
  expect(trojan.startsWith('trojan://pw%2Fwith%2Bspecial@h:8443?')).toBe(true)
  const hy2 = buildSingboxShareURL({ ...base, protocol: 'hysteria2' }, 'h')!
  expect(hy2.startsWith('hysteria2://')).toBe(true)
  expect(hy2).toContain('sni=www.cloudflare.com')
  const tuic = buildSingboxShareURL({ ...base, protocol: 'tuic-v5' }, 'h')!
  expect(tuic.startsWith('tuic://uuid-1:pw%2Fwith%2Bspecial@h:8443?')).toBe(true)
  const anytls = buildSingboxShareURL({ ...base, protocol: 'anytls' }, 'h')!
  expect(anytls.startsWith('anytls://')).toBe(true)
})

test('xray builder supports vless-reality + vmess-ws only', () => {
  const xr: ProxyInboundFull = {
    ...REALITY, protocol: 'vless-reality', public_key: 'XPUB', short_id: 'ff00',
  }
  const url = buildXrayShareURL(xr, 'edge')!
  expect(url).toContain('pbk=XPUB')
  expect(url).toContain('sid=ff00')
  const vmess = buildXrayShareURL({ ...xr, protocol: 'vmess-ws', ws_path: '/ws' }, 'edge')!
  expect(vmess.startsWith('vmess://')).toBe(true)
  // shadowsocks has no xray URL builder
  expect(buildXrayShareURL({ ...xr, protocol: 'shadowsocks' }, 'edge')).toBeNull()
})

test('shareURLFor: xray restricts to its 2 protocols; forward relay reuses landing secrets + relay port', () => {
  const empty = new Map<number, ProxyInboundFull>()
  // xray: only vless-reality/vmess-ws produce a URL
  expect(shareURLFor('xray', { ...REALITY, public_key: 'XP', protocol: 'vless-reality' }, 'h', empty)).not.toBeNull()
  expect(shareURLFor('xray', { ...REALITY, protocol: 'trojan-tls', password: 'p' }, 'h', empty)).toBeNull()

  // sing-box forward relay: URL is built from the LANDING's secrets but the relay's port.
  const landing = { ...REALITY, id: 1, port: 8443 }
  const byID = new Map<number, ProxyInboundFull>([[1, landing]])
  const relay: ProxyInboundFull = {
    id: 2, server_id: 9, server_name: 'edge2', tag: 'relay-9999', alias: '', port: 9999,
    role: 'relay', protocol: 'vless-reality', relay_mode: 'forward', upstream_inbound_id: 1,
  }
  const url = shareURLFor('singbox', relay, 'relay.example.com', byID)!
  expect(url).toContain('@relay.example.com:9999') // relay host:port
  expect(url).toContain('uuid-1')                  // landing's uuid
  expect(url).toContain('pbk=PUBKEY')              // landing's reality key
})

test('URL protocol sets match the implemented builders', () => {
  expect(SINGBOX_URL_PROTOCOLS.size).toBe(18)
  expect(SINGBOX_URL_PROTOCOLS.has('vless-reality')).toBe(true)
  expect(XRAY_URL_PROTOCOLS.has('vmess-ws')).toBe(true)
  expect(XRAY_URL_PROTOCOLS.has('shadowsocks')).toBe(false)
})

// ── per-protocol predicates ─────────────────────────────────────────────────────

test('field predicates mirror the web InboundDialog', () => {
  expect(needsUUID('vless-reality')).toBe(true)
  expect(needsUUID('tuic-v5')).toBe(true)
  expect(needsUUID('trojan-tls')).toBe(false)
  expect(needsPassword('trojan-tls')).toBe(true)
  expect(needsPassword('hysteria2')).toBe(true)
  expect(needsReality('vless-reality')).toBe(true)
  expect(needsReality('vless-ws-tls')).toBe(false)
  expect(needsSS('shadowsocks-2022')).toBe(true)
  // cert-and-SNI: TLS protocols that aren't reality/ss
  expect(needsCertAndSNI('vless-ws-tls')).toBe(true)
  expect(needsCertAndSNI('hysteria2')).toBe(true)
  expect(needsCertAndSNI('vless-reality')).toBe(false)
  expect(needsCertAndSNI('shadowsocks-2022')).toBe(false)
  expect(needsTransport('vmess-http')).toBe(true)
  expect(needsTransport('vless-ws-tls')).toBe(true)
  expect(needsTransport('vless-reality')).toBe(false)
})

test('singboxCreatableOnMobile defers cert-backed TLS protocols, allows reality/ss/vmess-tcp', () => {
  expect(singboxCreatableOnMobile('vless-reality')).toBe(true)
  expect(singboxCreatableOnMobile('shadowsocks-2022')).toBe(true)
  expect(singboxCreatableOnMobile('vmess-tcp')).toBe(true)
  expect(singboxCreatableOnMobile('vless-ws-tls')).toBe(false) // needs a cert → web-only
  expect(singboxCreatableOnMobile('hysteria2')).toBe(false)
})

// ── random helpers (RN-safe, deterministic enough to validate shape) ───────────

test('random helpers produce well-formed values', () => {
  expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const port = randomPort()
  expect(port).toBeGreaterThanOrEqual(10000)
  expect(port).toBeLessThan(60000)
  expect(randomPassword()).not.toMatch(/[+/=]/) // url-safe, unpadded
  // SS2022 aes-128 → 16 bytes → 24 standard-base64 chars (with padding)
  const k = randomSSKey('2022-blake3-aes-128-gcm')
  expect(k.length).toBe(24)
  expect(k.endsWith('==')).toBe(true)
  // legacy method reuses randomPassword (url-safe)
  expect(randomSSKey('aes-256-gcm')).not.toMatch(/[+/=]/)
})
