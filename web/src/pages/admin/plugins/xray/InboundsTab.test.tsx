import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundsTab from './InboundsTab'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [
    { id: 10, name: 'tokyo-1', ssh_host: { Valid: true, String: '10.0.0.1' } },
    { id: 20, name: 'osaka-1', ssh_host: { Valid: true, String: '10.0.0.2' } },
  ] }),
}))

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    listXrayInbounds: vi.fn().mockResolvedValue([
      {
        id: 1, server_id: 10, server_name: 'tokyo-1', tag: 'landing-aa', port: 443,
        role: 'landing', protocol: 'vless-reality',
        uuid: 'u1', sni: 'www.lovelive-anime.jp', public_key: 'P1', private_key: '[REDACTED]', short_id: 'aa',
        ws_path: '', ss_method: '',
        upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
        created_at: '', updated_at: '',
      },
      {
        id: 2, server_id: 10, server_name: 'tokyo-1', tag: 'landing-bb', port: 8443,
        role: 'landing', protocol: 'vless-reality',
        uuid: 'u2', sni: 'www.apple.com', public_key: 'P2', private_key: '[REDACTED]', short_id: 'bb',
        ws_path: '', ss_method: '',
        upstream_inbound_id: null, upstream_tag: null, upstream_server_id: null, upstream_server_name: null,
        created_at: '', updated_at: '',
      },
      {
        id: 3, server_id: 20, server_name: 'osaka-1', tag: 'relay-cc', port: 18443,
        role: 'relay', protocol: 'vless-reality',
        uuid: 'u3', sni: 'www.swift.org', public_key: 'P3', private_key: '[REDACTED]', short_id: 'cc',
        ws_path: '', ss_method: '',
        upstream_inbound_id: 1, upstream_tag: 'landing-aa',
        upstream_server_id: 10, upstream_server_name: 'tokyo-1',
        created_at: '', updated_at: '',
      },
    ] as pluginsAPI.XrayInbound[]),
    listPluginHosts: vi.fn().mockResolvedValue([
      { id: 1, server_id: 10, config: {}, deployed_version: '1.8.11', status: 'running', last_error: null, updated_at: '' },
      { id: 2, server_id: 20, config: {}, deployed_version: '1.8.11', status: 'running', last_error: null, updated_at: '' },
    ]),
    fetchXrayTrafficBatch: vi.fn().mockResolvedValue({ resolution: 'raw', series: [] }),
  }
})

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('InboundsTab', () => {
  it('groups inbounds by server and shows tags + roles', async () => {
    wrap(<InboundsTab />)
    expect(await screen.findByText('tokyo-1')).toBeInTheDocument()
    expect(screen.getByText('osaka-1')).toBeInTheDocument()
    expect(screen.getByText('landing-aa')).toBeInTheDocument()
    expect(screen.getByText('landing-bb')).toBeInTheDocument()
    expect(screen.getByText('relay-cc')).toBeInTheDocument()
    // Relay row shows upstream tag@server
    expect(screen.getByText(/landing-aa.*tokyo-1|tokyo-1.*landing-aa/)).toBeInTheDocument()
    // Traffic now lives in its own tab — InboundsTab has no traffic column.
    // Active/idle dot is rendered per-row (title attribute carries the label).
    const landingRow = screen.getByText('landing-aa').closest('tr')!
    expect(landingRow.querySelector('span[title*="active"], span[title*="idle"]')).toBeTruthy()
  })

  it('disables Delete on landing-aa because relay-cc depends on it', async () => {
    wrap(<InboundsTab />)
    const row = (await screen.findByText('landing-aa')).closest('tr')!
    const del = row.querySelector('button[title*="depend"]') as HTMLButtonElement | null
    expect(del?.disabled).toBe(true)
  })
})
