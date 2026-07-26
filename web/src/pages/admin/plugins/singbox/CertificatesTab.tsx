import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/Pill'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useUI } from '@/store/ui'
import {
  listSingboxCerts,
  issueSingboxCert,
  renewSingboxCert,
  deleteSingboxCert,
  listSingboxInbounds,
  type SingboxCertificate,
  type SingboxInbound,
} from '@/api/plugins'
import { APIError } from '@/api/client'

// ─── helpers ─────────────────────────────────────────────────────────────────

function statusKind(
  s: SingboxCertificate['status'],
): 'ok' | 'warn' | 'err' | 'neutral' {
  if (s === 'active')  return 'ok'
  if (s === 'issuing') return 'warn'
  if (s === 'failed')  return 'err'
  return 'neutral' // revoked
}

/** Color class for expires_at cell.
 *  gray   — status is not 'active' (no meaningful expiry)
 *  red    — < 7 days
 *  yellow — 7–30 days
 *  green  — > 30 days
 */
function expiryClass(expires: string | null, status: SingboxCertificate['status']): string {
  if (status !== 'active' || !expires) return 'text-muted-foreground'
  const days = (new Date(expires).getTime() - Date.now()) / 86_400_000
  if (days < 7)  return 'text-destructive font-semibold'
  if (days < 30) return 'text-warn'
  return 'text-ok'
}

// ─── IssueCertDialog ──────────────────────────────────────────────────────────

interface IssueCertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function IssueCertDialog({ open, onOpenChange }: IssueCertDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)

  const [domain,        setDomain]        = useState('')
  const [email,         setEmail]         = useState('')
  const [challengeType, setChallengeType] = useState<'dns-01-cf' | 'http-01'>('dns-01-cf')
  const [errors,        setErrors]        = useState<Record<string, string>>({})

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!domain.match(/^[a-zA-Z0-9*][a-zA-Z0-9.*-]*\.[a-zA-Z]{2,}$/)) {
      e.domain = t('singbox.certificates.issue_dialog.domain_error', 'Enter a valid hostname (e.g. proxy.example.com)')
    }
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      e.email = t('singbox.certificates.issue_dialog.email_error', 'Enter a valid email address')
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const issue = useMutation({
    mutationFn: () => issueSingboxCert({ domain, email, challenge_type: challengeType }),
    onSuccess: () => {
      toast('success', t('singbox.certificates.issue_dialog.success_toast', 'Certificate issuance started for {{domain}}', { domain }))
      qc.invalidateQueries({ queryKey: ['singbox-certs'] })
      onOpenChange(false)
      setDomain('')
      setEmail('')
      setChallengeType('dns-01-cf')
      setErrors({})
    },
    onError: (e: unknown) => {
      toast('error', String((e as Error)?.message ?? e))
    },
  })

  function handleSubmit() {
    if (validate()) issue.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{t('singbox.certificates.issue_dialog.title', 'Issue Certificate')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Domain */}
          <div className="space-y-1">
            <Label htmlFor="ic-domain">{t('singbox.certificates.issue_dialog.domain_label', 'Domain')}</Label>
            <Input
              id="ic-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="proxy.example.com"
            />
            {errors.domain && (
              <p className="text-xs text-destructive">{errors.domain}</p>
            )}
          </div>

          {/* Email */}
          <div className="space-y-1">
            <Label htmlFor="ic-email">{t('singbox.certificates.issue_dialog.email_label', 'Email')}</Label>
            <Input
              id="ic-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
            />
            {errors.email && (
              <p className="text-xs text-destructive">{errors.email}</p>
            )}
          </div>

          {/* Challenge type */}
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium leading-none">{t('singbox.certificates.issue_dialog.challenge_type_label', 'Challenge type')}</legend>
            <div className="space-y-1.5 pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="ic-challenge"
                  value="dns-01-cf"
                  checked={challengeType === 'dns-01-cf'}
                  onChange={() => setChallengeType('dns-01-cf')}
                />
                {t('singbox.certificates.issue_dialog.challenge_dns_cf', 'DNS-01 (Cloudflare)')}
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="ic-challenge"
                  value="http-01"
                  checked={challengeType === 'http-01'}
                  onChange={() => setChallengeType('http-01')}
                />
                {t('singbox.certificates.issue_dialog.challenge_http', 'HTTP-01')}
              </label>
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            disabled={issue.isPending}
            onClick={handleSubmit}
          >
            {issue.isPending ? t('singbox.certificates.issue_dialog.issuing', 'Issuing…') : t('singbox.certificates.issue_dialog.issue', 'Issue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── CertificatesTab ──────────────────────────────────────────────────────────

export default function CertificatesTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [showIssue, setShowIssue] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<SingboxCertificate | null>(null)

  // Poll fast (2s) whenever any cert is mid-issuance — ACME completes
  // in seconds-to-minutes and the user wants the status pill to flip
  // promptly. Otherwise back off to 30s so a tab left open doesn't hit
  // the API every couple seconds forever. Same dynamic-interval pattern
  // ServerList uses for install_stage transitions.
  const { data: certs = [] } = useQuery({
    queryKey: ['singbox-certs'],
    queryFn: listSingboxCerts,
    refetchInterval: (q) => {
      const rows = (q?.state?.data as Array<{ status?: string }> | undefined) ?? []
      const transient = rows.some((r) => r.status === 'issuing')
      return transient ? 2000 : 30_000
    },
  })

  const { data: inbounds = [] } = useQuery<SingboxInbound[]>({
    queryKey: ['singbox-inbounds'],
    queryFn: () => listSingboxInbounds(),
  })

  // cert IDs referenced by any inbound
  const usedCertIDs = new Set(
    inbounds.map((i) => i.cert_id).filter((id): id is number => id != null),
  )

  const renew = useMutation({
    mutationFn: (id: number) => renewSingboxCert(id),
    onSuccess: (_, id) => {
      toast('success', t('singbox.certificates.renew_toast', 'Renewal queued for cert #{{id}}', { id }))
      qc.invalidateQueries({ queryKey: ['singbox-certs'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  const del = useMutation({
    mutationFn: (id: number) => deleteSingboxCert(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['singbox-certs'] })
    },
    onError: (e: unknown) => {
      const err = e as APIError
      if (err.status === 409) {
        // Message from server: "cert is in use by N inbound(s); remove them first"
        toast('error', err.message || t('singbox.certificates.delete_conflict_fallback', 'cert is in use; remove inbounds first'))
      } else {
        toast('error', String(err.message ?? e))
      }
    },
  })

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('singbox.certificates.title', 'TLS Certificates')}</h2>
        <Button size="sm" onClick={() => setShowIssue(true)}>
          + {t('singbox.certificates.issue_button', 'Issue cert')}
        </Button>
      </div>

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('singbox.certificates.domain', 'Domain')}</TableHead>
            <TableHead>{t('singbox.certificates.status', 'Status')}</TableHead>
            <TableHead>{t('singbox.certificates.issuer', 'Issuer')}</TableHead>
            <TableHead>{t('singbox.certificates.expires', 'Expires')}</TableHead>
            <TableHead>{t('singbox.certificates.challenge', 'Challenge')}</TableHead>
            <TableHead>{t('singbox.certificates.last_error', 'Last error')}</TableHead>
            <TableHead>{t('admin.actions', 'Actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {certs.length === 0 && (
            <TableEmpty colSpan={7}>
              {t('singbox.empty.certificates', 'No certificates yet. Click "+ Issue cert" to get started.')}
            </TableEmpty>
          )}
          {certs.map((c) => (
            <TableRow key={c.id}>
              {/* Domain */}
              <TableCell className="font-mono text-xs">{c.domain}</TableCell>

              {/* Status pill */}
              <TableCell>
                <Pill kind={statusKind(c.status)}>{c.status}</Pill>
              </TableCell>

              {/* Issuer */}
              <TableCell className="text-xs">{c.issuer ?? '—'}</TableCell>

              {/* Expires */}
              <TableCell className={`text-xs ${expiryClass(c.expires_at, c.status)}`}>
                {c.expires_at
                  ? new Date(c.expires_at).toLocaleDateString()
                  : '—'}
              </TableCell>

              {/* Challenge */}
              <TableCell className="text-xs">{c.challenge_type}</TableCell>

              {/* Last error — icon + tooltip. shadcn Tooltip replaces
                  the native `title` attribute which (a) was too slow
                  to surface on hover and (b) had a hit area limited
                  to the 1ch ⚠ glyph. The trigger is now button-sized
                  + opens on focus too. */}
              <TableCell>
                {c.last_error ? (
                  <TooltipProvider delayDuration={150}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60"
                          aria-label={t('singbox.certificates.show_last_error_aria', 'Show last error')}
                        >
                          ⚠
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-md break-words text-xs">
                        {c.last_error}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>

              {/* Actions */}
              <TableCell>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={renew.isPending}
                    onClick={() => renew.mutate(c.id)}
                  >
                    {t('singbox.certificates.renew', 'Renew')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={usedCertIDs.has(c.id) || del.isPending}
                    title={
                      usedCertIDs.has(c.id)
                        ? t('singbox.certificates.delete_disabled_title', 'cert is in use by inbound(s); remove them first')
                        : undefined
                    }
                    onClick={() => setPendingDelete(c)}
                  >
                    {t('admin.delete', 'Delete')}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Issue cert dialog */}
      <IssueCertDialog open={showIssue} onOpenChange={setShowIssue} />

      <ConfirmDialog
        open={pendingDelete != null}
        onOpenChange={(open) => { if (!open) setPendingDelete(null) }}
        title={t('singbox.delete_certificate')}
        description={t('singbox.delete_certificate_confirm', { name: pendingDelete?.domain ?? '' })}
        onConfirm={() => { if (pendingDelete) del.mutate(pendingDelete.id) }}
      />
    </div>
  )
}
