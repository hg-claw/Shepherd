import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CertificatesTab from './CertificatesTab'
import type { SingboxCertificate } from '@/api/plugins'
import { APIError } from '@/api/client'

// vi.mock is hoisted above imports — data defined inline
vi.mock('@/api/plugins', () => ({
  listSingboxCerts: vi.fn().mockResolvedValue([
    {
      id: 1,
      domain: 'proxy.example.com',
      issuer: "Let's Encrypt",
      status: 'active',
      expires_at: '2026-08-01T00:00:00Z',
      challenge_type: 'http-01',
      last_renew_attempt_at: null,
      last_error: null,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    } satisfies SingboxCertificate,
    {
      id: 2,
      domain: 'relay.example.com',
      issuer: "Let's Encrypt",
      status: 'failed',
      expires_at: null,
      challenge_type: 'dns-01-cf',
      last_renew_attempt_at: null,
      last_error: 'DNS propagation timeout',
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    } satisfies SingboxCertificate,
  ]),
  issueSingboxCert:    vi.fn().mockResolvedValue({ id: 3, status: 'issuing' }),
  renewSingboxCert:    vi.fn().mockResolvedValue({ id: 1, status: 'issuing' }),
  deleteSingboxCert:   vi.fn().mockResolvedValue(undefined),
  listSingboxInbounds: vi.fn().mockResolvedValue([]),
}))

const mockToast = vi.fn()

vi.mock('@/store/ui', () => ({
  useUI: (fn: (s: { toast: (...args: unknown[]) => void }) => unknown) =>
    fn({ toast: mockToast }),
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

beforeEach(() => {
  mockToast.mockClear()
})

// ─── TestCertificatesTab_RendersCerts ─────────────────────────────────────────

describe('singbox/CertificatesTab', () => {
  it('TestCertificatesTab_RendersCerts: lists certificates with domain and status pills', async () => {
    const { deleteSingboxCert } = await import('@/api/plugins')
    vi.mocked(deleteSingboxCert).mockResolvedValue(undefined)

    render(<CertificatesTab />, { wrapper })
    await waitFor(() => {
      expect(screen.getByText('proxy.example.com')).toBeTruthy()
      expect(screen.getByText('relay.example.com')).toBeTruthy()
      expect(screen.getByText('active')).toBeTruthy()
      expect(screen.getByText('failed')).toBeTruthy()
    })
  })

  // ─── TestCertificatesTab_DeleteBlockedByFK ────────────────────────────────

  it('TestCertificatesTab_DeleteBlockedByFK: 409 from delete shows toast with usage message', async () => {
    const { deleteSingboxCert } = await import('@/api/plugins')
    vi.mocked(deleteSingboxCert).mockRejectedValueOnce(
      new APIError(409, 'cert is in use by 2 inbound(s)'),
    )

    render(<CertificatesTab />, { wrapper })

    const deleteButtons = await screen.findAllByRole('button', { name: /delete/i })
    fireEvent.click(deleteButtons[0])

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        'error',
        expect.stringContaining('in use'),
      )
    })
  })

  // ─── TestIssueCertDialog_SubmitsBody ──────────────────────────────────────

  it('TestIssueCertDialog_SubmitsBody: fills form and submits issueSingboxCert with correct body', async () => {
    const { issueSingboxCert } = await import('@/api/plugins')
    vi.mocked(issueSingboxCert).mockResolvedValue({
      id: 3,
      domain: 'new.example.com',
      issuer: "Let's Encrypt",
      status: 'issuing',
      expires_at: null,
      challenge_type: 'http-01',
      last_renew_attempt_at: null,
      last_error: null,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    })

    render(<CertificatesTab />, { wrapper })

    // Open the issue dialog
    const issueBtn = await screen.findByRole('button', { name: /issue cert/i })
    fireEvent.click(issueBtn)

    await waitFor(() => {
      expect(screen.getByLabelText(/domain/i)).toBeTruthy()
    })

    // Fill domain
    fireEvent.change(screen.getByLabelText(/domain/i), {
      target: { value: 'new.example.com' },
    })

    // Fill email
    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: 'admin@example.com' },
    })

    // Select HTTP-01 challenge radio
    const httpRadio = screen.getByDisplayValue('http-01')
    fireEvent.click(httpRadio)

    // Submit (the button inside the dialog labelled "Issue")
    const submitBtn = screen.getByRole('button', { name: /^issue$/i })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(issueSingboxCert).toHaveBeenCalledWith({
        domain: 'new.example.com',
        email: 'admin@example.com',
        challenge_type: 'http-01',
      })
    })
  })
})
