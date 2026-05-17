// web/src/pages/admin/plugins/xray/templates.ts
// Mirrors internal/plugins/xray/config.go RenderTemplate.
// We render the xray config in the browser and send it as `config` to the
// deploy endpoint; the server pushes it verbatim to the host after
// NormaliseRaw re-pretty-prints it.

export type Inbound = 'vless-reality' | 'vmess-ws' | 'shadowsocks'

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
  // Shadowsocks
  method?: string
  password?: string
}

export function renderTemplate(v: TemplateValues): Record<string, unknown> {
  switch (v.inbound) {
    case 'vless-reality': return vlessReality(v)
    case 'vmess-ws':      return vmessWS(v)
    case 'shadowsocks':   return shadowsocks(v)
  }
}

function vlessReality(v: TemplateValues) {
  return {
    log: { loglevel: 'warning' },
    inbounds: [{
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
    }],
    outbounds: [{ protocol: 'freedom' }],
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
    }],
    outbounds: [{ protocol: 'freedom' }],
  }
}

function shadowsocks(v: TemplateValues) {
  return {
    inbounds: [{
      port: v.port,
      protocol: 'shadowsocks',
      settings: { method: v.method, password: v.password },
    }],
    outbounds: [{ protocol: 'freedom' }],
  }
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
