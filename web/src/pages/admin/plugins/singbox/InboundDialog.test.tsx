import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import InboundDialog from './InboundDialog'

vi.mock('@/api/plugins', () => ({
  listSingboxCerts:     vi.fn().mockResolvedValue([
    {
      id: 1,
      domain: 'proxy.example.com',
      status: 'active',
      issuer: 'LE',
      expires_at: null,
      challenge_type: 'http-01',
      last_renew_attempt_at: null,
      last_error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ]),
  createSingboxInbound: vi.fn().mockResolvedValue({ id: 99, tag: 'landing-new' }),
  patchSingboxInbound:  vi.fn().mockResolvedValue({ id: 1 }),
  generateX25519:       vi.fn().mockResolvedValue({ private_key: 'priv123', public_key: 'pub456' }),
  generateShortID:      vi.fn().mockResolvedValue({ short_id: 'aabb1122' }),
}))

vi.mock('@/store/ui', () => ({
  useUI: (fn: (s: { toast: (...args: unknown[]) => void }) => unknown) =>
    fn({ toast: vi.fn() }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('singbox/InboundDialog', () => {
  it('shows port field for all protocols', () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper },
    )
    // Use the specific id rather than a regex that might match multiple labels
    expect(screen.getByLabelText('Port')).toBeTruthy()
  })

  it('shows uuid field when protocol is vless-reality (default)', async () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper },
    )
    // vless-reality is the default protocol — UUID field must be visible
    await waitFor(() => expect(screen.getByLabelText(/uuid/i)).toBeTruthy())
  })

  it('shows password field when protocol is trojan-tls', async () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper },
    )
    const select = screen.getByRole('combobox', { name: /protocol/i })
    fireEvent.change(select, { target: { value: 'trojan-tls' } })
    await waitFor(() => expect(screen.getByLabelText(/password/i)).toBeTruthy())
  })

  it('shows ss_method dropdown for shadowsocks-2022', async () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper },
    )
    const select = screen.getByRole('combobox', { name: /protocol/i })
    fireEvent.change(select, { target: { value: 'shadowsocks-2022' } })
    await waitFor(() => expect(screen.getByLabelText(/method/i)).toBeTruthy())
  })

  it('locks protocol select in edit mode', async () => {
    const inbound = {
      id: 5,
      server_id: 1,
      server_name: 'S1',
      tag: 'landing-abc',
      port: 443,
      role: 'landing' as const,
      protocol: 'trojan-tls' as const,
      password: 'hunter2',
      sni: 'example.com',
      cert_id: 1,
      upstream_inbound_id: null,
      upstream_tag: null,
      upstream_server_id: null,
      upstream_server_name: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    render(
      <InboundDialog serverID={1} initial={inbound} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper },
    )
    const select = screen.getByRole('combobox', { name: /protocol/i })
    expect((select as HTMLSelectElement).disabled).toBe(true)
  })

  it('hides reality fields and shows password + cert when switching from vless-reality to trojan-tls', async () => {
    render(
      <InboundDialog serverID={1} open onClose={() => {}} onSaved={() => {}} />,
      { wrapper },
    )
    // Default = vless-reality — short-id label should be present
    await waitFor(() => expect(screen.getByLabelText(/short id/i)).toBeTruthy())

    // Switch to trojan-tls
    const select = screen.getByRole('combobox', { name: /protocol/i })
    fireEvent.change(select, { target: { value: 'trojan-tls' } })

    await waitFor(() => {
      expect(screen.queryByLabelText(/short id/i)).toBeNull()
      expect(screen.getByLabelText(/password/i)).toBeTruthy()
    })
  })
})
