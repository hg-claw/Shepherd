import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import DnsTab from './DnsTab'

const LONG_TXT = 'v=spf1 ' + 'include:_spf.example.net '.repeat(20) + '-all'

const RECORDS = [
  { id: 'r1', name: 'a.example.com', type: 'A', content: '1.2.3.4', ttl: 1, proxied: false },
  { id: 'r2', name: 'txt.example.com', type: 'TXT', content: LONG_TXT, ttl: 1 },
]

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn().mockImplementation((url: string) =>
      url.includes('/zones?') || url === '/api/admin/plugins/cloudflare/zones'
        ? Promise.resolve([{ id: 'z1', name: 'example.com' }])
        : Promise.resolve(RECORDS)
    ),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    del: vi.fn().mockResolvedValue({}),
  },
}))

import { api } from '@/api/client'
const mockPatch = api.patch as unknown as Mock

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}><DnsTab /></QueryClientProvider>
    </I18nextProvider>,
  )
}

describe('cloudflare DnsTab', () => {
  beforeEach(() => vi.clearAllMocks())

  it('lists records for the selected zone', async () => {
    renderTab()
    await screen.findByText('example.com')
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeTruthy())
  })

  it('truncates long TXT content with the full value in the tooltip', async () => {
    renderTab()
    await waitFor(() => {
      const cell = screen.getByTitle(LONG_TXT)
      expect(cell.className).toContain('truncate')
    })
  })

  it('edit dialog prefills the record and PATCHes the update', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('a.example.com')).toBeTruthy())

    const row = screen.getByText('a.example.com').closest('tr')!
    fireEvent.click(row.querySelector('button')!) // first action button = Edit

    const dialog = await screen.findByRole('dialog')
    const contentInput = dialog.querySelector('#cf-edit-content') as HTMLInputElement
    expect(contentInput.value).toBe('1.2.3.4')

    fireEvent.change(contentInput, { target: { value: '5.6.7.8' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(mockPatch).toHaveBeenCalledWith(
        '/api/admin/plugins/cloudflare/zones/z1/records/r1',
        expect.objectContaining({ type: 'A', name: 'a.example.com', content: '5.6.7.8', ttl: 1, proxied: false }),
      )
    })
  })

  it('omits proxied for TXT records (Cloudflare rejects it)', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle(LONG_TXT)).toBeTruthy())

    const row = screen.getByTitle(LONG_TXT).closest('tr')!
    fireEvent.click(row.querySelector('button')!)

    await screen.findByRole('dialog')
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const [, body] = mockPatch.mock.calls[0] as [string, Record<string, unknown>]
      expect(mockPatch.mock.calls[0][0]).toBe('/api/admin/plugins/cloudflare/zones/z1/records/r2')
      expect('proxied' in body).toBe(false)
    })
  })
})
