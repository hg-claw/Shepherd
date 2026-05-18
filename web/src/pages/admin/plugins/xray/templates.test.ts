// web/src/pages/admin/plugins/xray/templates.test.ts
import { describe, it, expect } from 'vitest'
import { renderTemplate, parseConfig, buildShareURL } from './templates'

describe('parseConfig', () => {
  it('round-trips vless-reality fields', () => {
    const cfg = renderTemplate({
      inbound: 'vless-reality',
      port: 8443,
      uuid: '11111111-1111-4111-8111-111111111111',
      sni: 'www.cloudflare.com',
      publicKey: 'pk',
      privateKey: 'sk',
      shortID: 'abcd',
    })
    const parsed = parseConfig(cfg)
    expect(parsed.inbound).toBe('vless-reality')
    expect(parsed.port).toBe(8443)
    expect(parsed.uuid).toBe('11111111-1111-4111-8111-111111111111')
    expect(parsed.sni).toBe('www.cloudflare.com')
    expect(parsed.publicKey).toBe('pk')
    expect(parsed.privateKey).toBe('sk')
    expect(parsed.shortID).toBe('abcd')
  })
  it('round-trips vmess-ws fields', () => {
    const cfg = renderTemplate({
      inbound: 'vmess-ws',
      port: 9000,
      uuid: '22222222-2222-4222-8222-222222222222',
      wsPath: '/custom',
    })
    const parsed = parseConfig(cfg)
    expect(parsed.inbound).toBe('vmess-ws')
    expect(parsed.port).toBe(9000)
    expect(parsed.uuid).toBe('22222222-2222-4222-8222-222222222222')
    expect(parsed.wsPath).toBe('/custom')
  })
  it('returns empty object for garbage', () => {
    expect(parseConfig(null)).toEqual({})
    expect(parseConfig({})).toEqual({})
    expect(parseConfig({ inbounds: 'no' })).toEqual({})
  })
})

describe('buildShareURL', () => {
  it('generates a vless-reality URL', () => {
    const cfg = renderTemplate({
      inbound: 'vless-reality', port: 443,
      uuid: '11111111-1111-4111-8111-111111111111',
      sni: 'www.cloudflare.com',
      publicKey: 'PK', privateKey: 'SK', shortID: 'ab',
    })
    const url = buildShareURL(parseConfig(cfg), '1.2.3.4', 'edge-1')!
    expect(url).toMatch(/^vless:\/\/11111111-1111-4111-8111-111111111111@1\.2\.3\.4:443\?/)
    expect(url).toContain('security=reality')
    expect(url).toContain('sni=www.cloudflare.com')
    expect(url).toContain('pbk=PK')
    expect(url).toContain('sid=ab')
    expect(url).toContain('flow=xtls-rprx-vision')
    expect(url.endsWith('#edge-1')).toBe(true)
  })

  it('generates a vmess-ws URL with base64 JSON payload', () => {
    const cfg = renderTemplate({
      inbound: 'vmess-ws', port: 9000,
      uuid: '22222222-2222-4222-8222-222222222222',
      wsPath: '/ws',
    })
    const url = buildShareURL(parseConfig(cfg), '1.2.3.4', 'ws-1')!
    expect(url.startsWith('vmess://')).toBe(true)
    const decoded = JSON.parse(atob(url.slice('vmess://'.length)))
    expect(decoded.add).toBe('1.2.3.4')
    expect(decoded.port).toBe('9000')
    expect(decoded.id).toBe('22222222-2222-4222-8222-222222222222')
    expect(decoded.path).toBe('/ws')
    expect(decoded.net).toBe('ws')
    expect(decoded.ps).toBe('ws-1')
  })

  it('returns null on incomplete data', () => {
    expect(buildShareURL({}, '1.2.3.4', 'x')).toBeNull()
    expect(buildShareURL({ inbound: 'vless-reality', port: 443, uuid: 'u', publicKey: 'k' }, '', 'x')).toBeNull()
    expect(buildShareURL({ inbound: 'vless-reality', port: 443, uuid: 'u' }, '1.2.3.4', 'x')).toBeNull()
  })
})
