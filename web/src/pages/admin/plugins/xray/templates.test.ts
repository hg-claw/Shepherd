// web/src/pages/admin/plugins/xray/templates.test.ts
import { describe, it, expect } from 'vitest'
import { renderTemplate, parseConfig } from './templates'

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
