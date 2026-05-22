import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
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

function statusVariant(
  s: SingboxCertificate['status'],
): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'active')  return 'default'
  if (s === 'issuing') return 'secondary'
  if (s === 'failed')  return 'destructive'
  return 'outline' // revoked
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
  if (days < 30) return 'text-amber-600'
  return 'text-green-600'
}

// ─── IssueCertDialog ──────────────────────────────────────────────────────────

interface IssueCertDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function IssueCertDialog({ open, onOpenChange }: IssueCertDialogProps) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)

  const [domain,        setDomain]        = useState('')
  const [email,         setEmail]         = useState('')
  const [challengeType, setChallengeType] = useState<'dns-01-cf' | 'http-01'>('dns-01-cf')
  const [errors,        setErrors]        = useState<Record<string, string>>({})

  function validate(): boolean {
    const e: Record<string, string> = {}
    if (!domain.match(/^[a-zA-Z0-9*][a-zA-Z0-9.*-]*\.[a-zA-Z]{2,}$/)) {
      e.domain = 'Enter a valid hostname (e.g. proxy.example.com)'
    }
    if (!email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
      e.email = 'Enter a valid email address'
    }
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const issue = useMutation({
    mutationFn: () => issueSingboxCert({ domain, email, challenge_type: challengeType }),
    onSuccess: () => {
      toast('success', `Certificate issuance started for ${domain}`)
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
          <DialogTitle>Issue Certificate</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Domain */}
          <div className="space-y-1">
            <Label htmlFor="ic-domain">Domain</Label>
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
            <Label htmlFor="ic-email">Email</Label>
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
            <legend className="text-sm font-medium leading-none">Challenge type</legend>
            <div className="space-y-1.5 pt-1">
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="ic-challenge"
                  value="dns-01-cf"
                  checked={challengeType === 'dns-01-cf'}
                  onChange={() => setChallengeType('dns-01-cf')}
                />
                DNS-01 (Cloudflare)
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="radio"
                  name="ic-challenge"
                  value="http-01"
                  checked={challengeType === 'http-01'}
                  onChange={() => setChallengeType('http-01')}
                />
                HTTP-01
              </label>
            </div>
          </fieldset>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={issue.isPending}
            onClick={handleSubmit}
          >
            {issue.isPending ? 'Issuing…' : 'Issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── CertificatesTab ──────────────────────────────────────────────────────────

export default function CertificatesTab() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [showIssue, setShowIssue] = useState(false)

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
      toast('success', `Renewal queued for cert #${id}`)
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
        toast('error', err.message || 'cert is in use; remove inbounds first')
      } else {
        toast('error', String(err.message ?? e))
      }
    },
  })

  return (
    <div className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">TLS Certificates</h2>
        <Button size="sm" onClick={() => setShowIssue(true)}>
          + Issue cert
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Domain</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-left font-medium">Issuer</th>
              <th className="px-3 py-2 text-left font-medium">Expires</th>
              <th className="px-3 py-2 text-left font-medium">Challenge</th>
              <th className="px-3 py-2 text-left font-medium">Last error</th>
              <th className="px-3 py-2 text-left font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {certs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No certificates yet. Click "+ Issue cert" to get started.
                </td>
              </tr>
            )}
            {certs.map((c) => (
              <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                {/* Domain */}
                <td className="px-3 py-2 font-mono text-xs">{c.domain}</td>

                {/* Status pill */}
                <td className="px-3 py-2">
                  <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                </td>

                {/* Issuer */}
                <td className="px-3 py-2 text-xs">{c.issuer ?? '—'}</td>

                {/* Expires */}
                <td className={`px-3 py-2 text-xs ${expiryClass(c.expires_at, c.status)}`}>
                  {c.expires_at
                    ? new Date(c.expires_at).toLocaleDateString()
                    : '—'}
                </td>

                {/* Challenge */}
                <td className="px-3 py-2 text-xs">{c.challenge_type}</td>

                {/* Last error — icon + tooltip. shadcn Tooltip replaces
                    the native `title` attribute which (a) was too slow
                    to surface on hover and (b) had a hit area limited
                    to the 1ch ⚠ glyph. The trigger is now button-sized
                    + opens on focus too. */}
                <td className="px-3 py-2">
                  {c.last_error ? (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="inline-flex h-6 w-6 items-center justify-center rounded text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/60"
                            aria-label="Show last error"
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
                </td>

                {/* Actions */}
                <td className="px-3 py-2">
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={renew.isPending}
                      onClick={() => renew.mutate(c.id)}
                    >
                      Renew
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={usedCertIDs.has(c.id) || del.isPending}
                      title={
                        usedCertIDs.has(c.id)
                          ? 'cert is in use by inbound(s); remove them first'
                          : undefined
                      }
                      onClick={() => del.mutate(c.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Issue cert dialog */}
      <IssueCertDialog open={showIssue} onOpenChange={setShowIssue} />
    </div>
  )
}
