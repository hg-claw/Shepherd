import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import InboundDialog from './InboundDialog'
import * as pluginsAPI from '@/api/plugins'

vi.mock('@/api/plugins', () => ({
  createMieruInbound: vi.fn().mockResolvedValue({ id: 1, tag: 'landing-aabbccdd' }),
  patchMieruInbound: vi.fn().mockResolvedValue({ id: 1 }),
}))

vi.mock('@/api/servers', () => ({
  useServers: () => ({ data: [{ id: 1, name: 'edge' }] }),
}))

vi.mock('@/store/ui', () => ({
  useUI: (fn: (s: { toast: () => void }) => unknown) => fn({ toast: vi.fn() }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    </I18nextProvider>
  )
}

describe('mieru/InboundDialog', () => {
  beforeEach(async () => { await i18n.changeLanguage('en') })

  it('creates a TCP inbound with username and password', async () => {
    const spy = vi.spyOn(pluginsAPI, 'createMieruInbound')
    render(<InboundDialog open onOpenChange={() => {}} mode="create" defaultServerID={1} />, { wrapper })
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'secret' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    expect(spy.mock.calls[0][0]).toMatchObject({
      server_id: 1, username: 'alice', password: 'secret', protocol: 'TCP',
    })
  })
})
