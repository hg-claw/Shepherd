import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import SetupTab from './SetupTab'

const put = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@/api/plugins', () => ({
  getPluginConfig: () => Promise.resolve({ api_token: '***' }),
  putPluginConfig: (id: string, body: any) => put(id, body),
}))

describe('cloudflare SetupTab', () => {
  it('does not re-send unchanged redacted token on save', async () => {
    const qc = new QueryClient()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}><SetupTab /></QueryClientProvider>
      </I18nextProvider>,
    )
    await screen.findByDisplayValue('***')
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(put).toHaveBeenCalledWith('cloudflare', { api_token: '***', account_id: '', zone_id: '', prefix: '' }))
  })
})
