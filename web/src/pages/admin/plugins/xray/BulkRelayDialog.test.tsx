import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import BulkRelayDialog from './BulkRelayDialog'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', async () => {
  const actual = await vi.importActual<typeof pluginsAPI>('@/api/plugins')
  return {
    ...actual,
    deployPluginHost: vi.fn().mockResolvedValue({}),
    fetchXrayVersions: vi.fn().mockResolvedValue({ latest: ['1.8.11'], cached: [] }),
    generateX25519: vi.fn().mockResolvedValue({ private_key: 'priv', public_key: 'pub' }),
    generateShortID: vi.fn().mockResolvedValue({ short_id: 'sid' }),
  }
})
vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [
    { id: 10, name: 'tokyo-1',  ssh_host: { Valid: true, String: '10.0.0.1' } },
    { id: 11, name: 'osaka-1',  ssh_host: { Valid: true, String: '10.0.0.2' } },
  ] }),
}))

const landing = {
  id: 1,
  server_id: 1,
  config: {
    inbounds: [{
      port: 8443, protocol: 'vless',
      settings: { clients: [{ id: 'lll', flow: 'xtls-rprx-vision' }], decryption: 'none' },
      streamSettings: {
        network: 'tcp', security: 'reality',
        realitySettings: { serverNames: ['www.icloud.com'], publicKey: 'LPUB', shortIds: ['ll'] },
      },
    }],
  },
  deployed_version: '1.8.11',
  status: 'running' as const,
  last_error: null,
  updated_at: '',
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe('BulkRelayDialog', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists target servers and calls deployPluginHost once per selected target', async () => {
    wrap(
      <BulkRelayDialog
        open={true}
        onOpenChange={() => {}}
        landing={landing}
        landingServerHost="1.2.3.4"
        landingServerName="us-1"
        existingXrayServerIDs={new Set([1])}
      />
    )

    // Pick both targets.
    fireEvent.click(await screen.findByLabelText(/tokyo-1/))
    fireEvent.click(screen.getByLabelText(/osaka-1/))

    fireEvent.click(screen.getByRole('button', { name: /deploy all/i }))

    await waitFor(() => {
      expect(pluginsAPI.deployPluginHost).toHaveBeenCalledTimes(2)
    })
    // First call: tokyo-1, role=relay, upstream=1.
    const firstCall = (pluginsAPI.deployPluginHost as any).mock.calls[0][1]
    expect(firstCall.server_id).toBe(10)
    expect(firstCall.topology).toEqual({ role: 'relay', upstream_server_id: 1 })
    expect(firstCall.version).toBe('1.8.11')
    expect((firstCall.config as any).outbounds[0].settings.vnext[0].address).toBe('1.2.3.4')
  })

  it('excludes the landing itself and already-xray-deployed servers from the target list', async () => {
    wrap(
      <BulkRelayDialog
        open={true}
        onOpenChange={() => {}}
        landing={landing}
        landingServerHost="1.2.3.4"
        landingServerName="us-1"
        existingXrayServerIDs={new Set([1, 10])} // 10 already has xray
      />
    )
    expect(screen.queryByLabelText(/tokyo-1/)).toBeNull()    // excluded
    expect(await screen.findByLabelText(/osaka-1/)).toBeInTheDocument()
  })
})
