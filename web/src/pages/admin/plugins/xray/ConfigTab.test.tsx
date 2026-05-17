import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import userEvent from '@testing-library/user-event'
import i18n from '@/i18n'
import ConfigTab from './ConfigTab'

const put = vi.fn().mockResolvedValue({ ok: true })
vi.mock('@/api/plugins', () => ({
  getPluginConfig: () => Promise.resolve({ default_version: '1.8.11' }),
  putPluginConfig: (id: string, body: any) => put(id, body),
  fetchXrayVersions: () => Promise.resolve({ cached: [], latest: [] }),
}))

describe('xray ConfigTab', () => {
  beforeEach(() => {
    put.mockClear()
  })

  it('saves edited default version', async () => {
    const qc = new QueryClient()
    const user = userEvent.setup()
    render(
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={qc}>
          <MemoryRouter><ConfigTab /></MemoryRouter>
        </QueryClientProvider>
      </I18nextProvider>,
    )
    const input = await screen.findByDisplayValue('1.8.11') as HTMLInputElement
    await user.click(input)
    await user.keyboard('{Control>}a{/Control}')
    await user.keyboard('1.8.20')
    await user.click(screen.getByText('Save'))
    await waitFor(() => expect(put).toHaveBeenCalledWith('xray', { default_version: '1.8.20' }))
  })
})
