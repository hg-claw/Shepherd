import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import PluginsIndex from './index'

vi.mock('@/api/plugins', () => ({
  listPlugins: () => Promise.resolve([
    { id: 'xray', meta: { name: 'xray', description: 'd', icon: 'shield', category: 'proxy', host_aware: true },
      enabled: true, enabled_at: '2026-05-16T00:00:00Z', host_count: 2 },
    { id: 'cloudflare', meta: { name: 'Cloudflare', description: 'd2', icon: 'cloud', category: 'dns', host_aware: false },
      enabled: false, enabled_at: null, host_count: null },
    { id: 'sshaudit', meta: { name: 'SSH Audit', description: 'd3', icon: 'shield', category: 'security', host_aware: true },
      enabled: true, enabled_at: '2026-05-16T00:00:00Z', host_count: 3 },
  ]),
  enablePlugin: vi.fn(),
  disablePlugin: vi.fn(),
}))

const fetchSSHAuditOverview = vi.fn(() => Promise.resolve({ window_hours: 24, accepted: 12, failed: 340 }))
vi.mock('@/api/sshaudit', () => ({
  fetchSSHAuditOverview: () => fetchSSHAuditOverview(),
}))

function renderPage() {
  const qc = new QueryClient()
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <PluginsIndex />
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  )
}

describe('PluginsIndex', () => {
  it('renders cards for each plugin', async () => {
    renderPage()
    expect(await screen.findByText('xray')).toBeTruthy()
    expect(await screen.findByText('Cloudflare')).toBeTruthy()
    expect(await screen.findByText('SSH Audit')).toBeTruthy()
  })

  it('shows the 24h login tally badge on the enabled sshaudit card', async () => {
    renderPage()
    // Wait for the overview query to resolve and render the badge.
    expect(await screen.findByText('✓ 12')).toBeTruthy()
    expect(await screen.findByText('✗ 340')).toBeTruthy()
    expect(fetchSSHAuditOverview).toHaveBeenCalled()
  })
})
