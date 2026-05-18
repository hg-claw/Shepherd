import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import DnsTab from './DnsTab'

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) =>
      url.includes('/zones?') || url === '/api/admin/plugins/cloudflare/zones'
        ? Promise.resolve([{ id: 'z1', name: 'example.com' }])
        : Promise.resolve([{ id: 'r1', name: 'a.example.com', type: 'A', content: '1.2.3.4', ttl: 1, proxied: false }])
    ),
    post: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue({}),
  },
}))

describe('cloudflare DnsTab', () => {
  it('lists records for the selected zone', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}><DnsTab /></QueryClientProvider>
      </I18nextProvider>,
    )
    await screen.findByText('example.com')
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeTruthy())
  })
})
