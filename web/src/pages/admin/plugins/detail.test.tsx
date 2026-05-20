import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import PluginDetail from './detail'

vi.mock('@/api/plugins', () => ({
  listPlugins: () => Promise.resolve([
    { id: 'xray', meta: { name: 'xray', description: '', icon: 'shield', category: 'proxy', host_aware: true },
      enabled: true, enabled_at: null, host_count: 0 },
  ]),
}))

describe('PluginDetail', () => {
  it('renders the tab bar for a known plugin', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/admin/plugins/xray']}>
            <Routes>
              <Route path="/admin/plugins/:id/*" element={<PluginDetail />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    expect(await screen.findByText('Deploy')).toBeTruthy()
    expect(screen.getByText('Inbounds')).toBeTruthy()
    expect(screen.getByText('Events')).toBeTruthy()
    expect(screen.getByText('Logs')).toBeTruthy()
  })
})
