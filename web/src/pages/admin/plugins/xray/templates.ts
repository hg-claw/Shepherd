// web/src/pages/admin/plugins/xray/templates.ts
// Mirrors internal/plugins/xray/config.go RenderTemplate.
// We render the xray config in the browser and send it as `config` to the
// deploy endpoint; the server pushes it verbatim to the host after
// NormaliseRaw re-pretty-prints it.

export type Inbound = 'vless-reality' | 'vmess-ws'

export interface LandingRef {
  address: string
  port: number
  sni: string
  uuid: string
  publicKey: string
  shortID: string
}

export interface TemplateValues {
  inbound: Inbound
  port: number
  uuid?: string
  // VLESS+REALITY
  sni?: string
  publicKey?: string
  privateKey?: string
  shortID?: string
  // VMess+WS
  wsPath?: string
  // Relay topology (vless-reality only)
  role?: 'landing' | 'relay'
  landing?: LandingRef
}

export function renderTemplate(v: TemplateValues): Record<string, unknown> {
  switch (v.inbound) {
    case 'vless-reality': return vlessReality(v)
    case 'vmess-ws':      return vmessWS(v)
  }
}

function vlessReality(v: TemplateValues) {
  const inbound = {
    port: v.port,
    protocol: 'vless',
    settings: {
      clients: [{ id: v.uuid, flow: 'xtls-rprx-vision' }],
      decryption: 'none',
    },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        show: false,
        dest: `${v.sni}:443`,
        serverNames: [v.sni],
        privateKey: v.privateKey,
        publicKey: v.publicKey,
        shortIds: [v.shortID ?? ''],
      },
    },
    sniffing: { enabled: true, destOverride: ['http', 'tls'] },
  }

  if (v.role === 'relay' && v.landing) {
    const l = v.landing
    return {
      log: { loglevel: 'warning' },
      inbounds: [inbound],
      outbounds: [
        {
          tag: 'to-landing',
          protocol: 'vless',
          settings: {
            vnext: [{
              address: l.address,
              port: l.port,
              users: [{ id: l.uuid, encryption: 'none', flow: 'xtls-rprx-vision' }],
            }],
          },
          streamSettings: {
            network: 'tcp',
            security: 'reality',
            realitySettings: {
              fingerprint: 'chrome',
              serverName: l.sni,
              publicKey: l.publicKey,
              shortId: l.shortID,
            },
          },
        },
        { tag: 'direct', protocol: 'freedom', settings: { domainStrategy: 'UseIP' } },
      ],
      routing: {
        rules: [{ type: 'field', ip: ['geoip:private'], outboundTag: 'direct' }],
      },
    }
  }

  return {
    log: { loglevel: 'warning' },
    inbounds: [inbound],
    outbounds: [{ protocol: 'freedom', settings: { domainStrategy: 'UseIP' } }],
  }
}

function vmessWS(v: TemplateValues) {
  return {
    inbounds: [{
      port: v.port,
      protocol: 'vmess',
      settings: { clients: [{ id: v.uuid }] },
      streamSettings: {
        network: 'ws',
        wsSettings: { path: v.wsPath || '/ws' },
      },
      sniffing: { enabled: true, destOverride: ['http', 'tls'] },
    }],
    outbounds: [{ protocol: 'freedom', settings: { domainStrategy: 'UseIP' } }],
  }
}

export interface ParsedTemplate extends Partial<TemplateValues> {
  inbound?: Inbound
}

// parseConfig is the inverse of renderTemplate: best-effort extraction of
// the user-visible fields from a previously-stored xray config. Returns
// what it can; unknown / missing fields are left undefined.
export function parseConfig(cfg: unknown): ParsedTemplate {
  if (!cfg || typeof cfg !== 'object') return {}
  const inbounds = (cfg as any).inbounds
  if (!Array.isArray(inbounds) || inbounds.length === 0) return {}
  const ib = inbounds[0] as any
  const proto = String(ib?.protocol ?? '')
  const ss = ib?.streamSettings ?? {}
  const security = String(ss?.security ?? '')
  const port = typeof ib?.port === 'number' ? ib.port : undefined

  if (proto === 'vless' && security === 'reality') {
    const rs = ss.realitySettings ?? {}
    const client = ib?.settings?.clients?.[0] ?? {}
    const base: ParsedTemplate = {
      inbound: 'vless-reality',
      port,
      uuid: typeof client.id === 'string' ? client.id : undefined,
      sni: Array.isArray(rs.serverNames) && rs.serverNames[0] ? String(rs.serverNames[0]) : undefined,
      publicKey: typeof rs.publicKey === 'string' ? rs.publicKey : undefined,
      privateKey: typeof rs.privateKey === 'string' ? rs.privateKey : undefined,
      shortID: Array.isArray(rs.shortIds) && rs.shortIds[0] != null ? String(rs.shortIds[0]) : undefined,
    }
    // Detect relay shape by outbound[0] being vless+reality.
    const outs = (cfg as any).outbounds
    const o0 = Array.isArray(outs) ? outs[0] : null
    if (o0?.protocol === 'vless' && o0?.streamSettings?.security === 'reality') {
      const vnext = o0?.settings?.vnext?.[0]
      const user  = vnext?.users?.[0]
      const ors   = o0?.streamSettings?.realitySettings ?? {}
      base.role = 'relay'
      base.landing = {
        address:   String(vnext?.address ?? ''),
        port:      typeof vnext?.port === 'number' ? vnext.port : 0,
        sni:       String(ors?.serverName ?? ''),
        uuid:      String(user?.id ?? ''),
        publicKey: String(ors?.publicKey ?? ''),
        shortID:   String(ors?.shortId ?? ''),
      }
    } else {
      base.role = 'landing'
    }
    return base
  }
  if (proto === 'vmess' && ss.network === 'ws') {
    const client = ib?.settings?.clients?.[0] ?? {}
    const wsPath = ss?.wsSettings?.path
    return {
      inbound: 'vmess-ws',
      port,
      uuid: typeof client.id === 'string' ? client.id : undefined,
      wsPath: typeof wsPath === 'string' ? wsPath : undefined,
    }
  }
  return {}
}

export function buildShareURL(parsed: ParsedTemplate, hostname: string, label: string): string | null {
  if (!hostname || !parsed.port || !parsed.uuid) return null

  if (parsed.inbound === 'vless-reality') {
    if (!parsed.publicKey) return null
    const q = new URLSearchParams({
      encryption: 'none',
      security: 'reality',
      sni: parsed.sni ?? '',
      fp: 'chrome',
      pbk: parsed.publicKey,
      sid: parsed.shortID ?? '',
      type: 'tcp',
      flow: 'xtls-rprx-vision',
    })
    return `vless://${parsed.uuid}@${hostname}:${parsed.port}?${q.toString()}#${encodeURIComponent(label)}`
  }

  if (parsed.inbound === 'vmess-ws') {
    const obj = {
      v: '2',
      ps: label,
      add: hostname,
      port: String(parsed.port),
      id: parsed.uuid,
      aid: '0',
      scy: 'auto',
      net: 'ws',
      type: 'none',
      host: '',
      path: parsed.wsPath ?? '/ws',
      tls: '',
    }
    // btoa needs binary string; JSON is ASCII so utf8 fits.
    const json = JSON.stringify(obj)
    return `vmess://${btoa(json)}`
  }

  return null
}

// helpers
export function randomPort(): number {
  // 10000 – 59999 to avoid trampling well-known ports.
  return 10000 + Math.floor(Math.random() * 50000)
}

export function randomUUID(): string {
  if ('randomUUID' in crypto) return (crypto as any).randomUUID()
  // crypto.randomUUID is available in modern browsers; fall back to a
  // simple time-based stub for the unusual cases.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}
