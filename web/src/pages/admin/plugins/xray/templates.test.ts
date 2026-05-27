// web/src/pages/admin/plugins/xray/templates.test.ts
import { describe, it, expect } from 'vitest'
import { buildShareURL, randomPassword, randomSSKey } from './templates'

describe('buildShareURL', () => {
  it('generates a vless-reality URL', () => {
    const url = buildShareURL({
      inbound: 'vless-reality', port: 443,
      uuid: '11111111-1111-4111-8111-111111111111',
      sni: 'www.lovelive-anime.jp',
      publicKey: 'PK', shortID: 'ab',
    }, '1.2.3.4', 'edge-1')!
    expect(url).toMatch(/^vless:\/\/11111111-1111-4111-8111-111111111111@1\.2\.3\.4:443\?/)
    expect(url).toContain('security=reality')
    expect(url).toContain('sni=www.lovelive-anime.jp')
    expect(url).toContain('pbk=PK')
    expect(url).toContain('sid=ab')
    expect(url.endsWith('#edge-1')).toBe(true)
  })

  it('generates a vmess-ws URL with base64 JSON payload', () => {
    const url = buildShareURL({
      inbound: 'vmess-ws', port: 9000,
      uuid: '22222222-2222-4222-8222-222222222222',
      wsPath: '/ws',
    }, '1.2.3.4', 'ws-1')!
    expect(url.startsWith('vmess://')).toBe(true)
    const decoded = JSON.parse(atob(url.slice('vmess://'.length)))
    expect(decoded.add).toBe('1.2.3.4')
    expect(decoded.port).toBe('9000')
  })

  it('returns null on incomplete data', () => {
    expect(buildShareURL({ inbound: 'vless-reality', port: 0, uuid: 'u', publicKey: 'k' } as any, '1.2.3.4', 'x')).toBeNull()
    expect(buildShareURL({ inbound: 'vless-reality', port: 443, uuid: 'u', publicKey: 'k' } as any, '', 'x')).toBeNull()
    expect(buildShareURL({ inbound: 'vless-reality', port: 443, uuid: 'u' } as any, '1.2.3.4', 'x')).toBeNull()
  })
})

describe('randomPassword', () => {
  it('returns a non-empty url-safe base64 string with no padding', () => {
    const p = randomPassword()
    expect(p.length).toBeGreaterThan(0)
    expect(p).toMatch(/^[A-Za-z0-9_-]+$/)
  })
  it('is random (two calls differ)', () => {
    expect(randomPassword()).not.toBe(randomPassword())
  })
})

describe('randomSSKey', () => {
  const b64len = (s: string) => atob(s).length
  it('aes-128 SS2022 → 16-byte standard-base64 key', () => {
    expect(b64len(randomSSKey('2022-blake3-aes-128-gcm'))).toBe(16)
  })
  it('aes-256 / chacha SS2022 → 32-byte key', () => {
    expect(b64len(randomSSKey('2022-blake3-aes-256-gcm'))).toBe(32)
    expect(b64len(randomSSKey('2022-blake3-chacha20-poly1305'))).toBe(32)
  })
  it('legacy method → non-empty string', () => {
    expect(randomSSKey('aes-256-gcm').length).toBeGreaterThan(0)
  })
})
