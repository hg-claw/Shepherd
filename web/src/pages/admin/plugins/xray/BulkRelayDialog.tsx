import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useServers } from '@/api/servers'
import {
  createXrayInbound, fetchXrayVersions, generateX25519, generateShortID,
  type XrayInbound, type CreateXrayInboundBody,
} from '@/api/plugins'
import { useUI } from '@/store/ui'
import { randomPassword, randomPort, randomUUID } from './templates'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  landingInbound: XrayInbound   // selected landing inbound
  allInbounds: XrayInbound[]    // for port-conflict hints per-server
}

interface RelayDraft {
  serverID: number
  serverName: string
  port: number
  uuid?: string
  privateKey?: string
  publicKey?: string
  shortID?: string
  ssPassword?: string
}

function needsX25519(protocol: string): boolean {
  return protocol === 'vless-reality'
}

function newDraft(serverID: number, serverName: string, takenPorts: Set<number>, protocol: string): RelayDraft {
  let port = randomPort()
  while (takenPorts.has(port)) port = randomPort()
  const draft: RelayDraft = { serverID, serverName, port }

  if (protocol === 'vless-reality') {
    draft.uuid = randomUUID()
    draft.privateKey = ''
    draft.publicKey = ''
    draft.shortID = ''
  } else if (protocol === 'vmess-ws') {
    draft.uuid = randomUUID()
  } else if (protocol === 'shadowsocks') {
    draft.ssPassword = randomPassword()
  }

  return draft
}

function buildRelayBody(d: RelayDraft, landing: XrayInbound): CreateXrayInboundBody {
  const proto = landing.protocol
  const base: CreateXrayInboundBody = {
    server_id: d.serverID,
    port: d.port,
    role: 'relay',
    protocol: proto,
    upstream_inbound_id: landing.id,
  }

  if (proto === 'vless-reality') {
    return {
      ...base,
      uuid: d.uuid,
      sni: landing.sni,
      public_key: d.publicKey,
      private_key: d.privateKey,
      short_id: d.shortID,
    }
  }

  if (proto === 'vmess-ws') {
    return {
      ...base,
      uuid: d.uuid,
      ws_path: landing.ws_path,
    }
  }

  if (proto === 'shadowsocks') {
    return {
      ...base,
      ss_method: landing.ss_method,
      ss_password: d.ssPassword,
    }
  }

  return base
}

export default function BulkRelayDialog({ open, onOpenChange, landingInbound, allInbounds }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const versionsQ = useQuery({ queryKey: ['xray-versions'], queryFn: fetchXrayVersions, enabled: open })
  const proto = landingInbound.protocol

  // Map server_id -> Set<port> for port conflict avoidance.
  const portsByServer = useMemo(() => {
    const m = new Map<number, Set<number>>()
    for (const i of allInbounds) {
      const s = m.get(i.server_id) ?? new Set<number>()
      s.add(i.port); m.set(i.server_id, s)
    }
    return m
  }, [allInbounds])

  // Targets: ALL enrolled servers (multi-inbound makes "already has xray" irrelevant).
  // Exclude only the landing's own server (don't put a relay back at its own landing).
  const targets = useMemo(() => {
    return (serversQ.data ?? []).filter((s) => s.id !== landingInbound.server_id)
  }, [serversQ.data, landingInbound.server_id])

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [drafts, setDrafts] = useState<Map<number, RelayDraft>>(new Map())

  const toggle = (s: { id: number; name: string }) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(s.id)) {
        next.delete(s.id)
        setDrafts((dPrev) => { const d = new Map(dPrev); d.delete(s.id); return d })
      } else {
        next.add(s.id)
        const taken = portsByServer.get(s.id) ?? new Set<number>()
        setDrafts((dPrev) => {
          const d = new Map(dPrev)
          d.set(s.id, newDraft(s.id, s.name, taken, proto))
          return d
        })
      }
      return next
    })
  }

  const regenKeys = async (id: number) => {
    const kp = await generateX25519()
    const sid = await generateShortID()
    setDrafts((prev) => {
      const d = new Map(prev)
      const cur = d.get(id); if (!cur) return prev
      d.set(id, { ...cur, privateKey: kp.private_key, publicKey: kp.public_key, shortID: sid.short_id })
      return d
    })
  }

  // Eager fill on selection for vless-reality (defensive against the "click Deploy All before keys arrive" race)
  if (needsX25519(proto)) {
    for (const [id, d] of drafts) {
      if (!d.privateKey || !d.publicKey || !d.shortID) {
        void regenKeys(id); break
      }
    }
  }

  const deploy = useMutation({
    mutationFn: async () => {
      const ids = Array.from(selected.values()).sort((a, b) => a - b)
      let ok = 0, fail = 0
      for (const id of ids) {
        const d = drafts.get(id)!
        if (needsX25519(proto) && (!d.privateKey || !d.publicKey || !d.shortID)) {
          await regenKeys(id)
        }
        const refresh = drafts.get(id)!
        try {
          await createXrayInbound(buildRelayBody(refresh, landingInbound))
          ok++
          toast('success', t('xray.bulk_relay_dialog.deployed_toast', 'Deployed relay on {{server}}', { server: d.serverName }))
        } catch (e: any) {
          fail++
          toast('error', t('xray.bulk_relay_dialog.error_toast', '{{server}}: {{message}}', { server: d.serverName, message: String(e?.message ?? e) }))
        }
      }
      return { ok, fail }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
    },
    onSuccess: ({ ok, fail }) => {
      toast(fail === 0 ? 'success' : 'info', t('xray.bulk_relay_dialog.summary_toast', 'Bulk relay: {{ok}} ok, {{fail}} failed', { ok, fail }))
      if (fail === 0) onOpenChange(false)
    },
  })

  const version = versionsQ.data?.latest?.[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {t('xray.bulk_relay_dialog.title', 'Add relays → {{tag}} @ {{server}}', { tag: landingInbound.tag, server: landingInbound.server_name })}
          </DialogTitle>
          <p className="text-xs text-muted-foreground font-mono">{proto}</p>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-xs">{t('xray.bulk_relay_dialog.targets_label', 'Target servers')}</Label>
            <div className="mt-1 rounded-md border bg-elev max-h-64 overflow-y-auto">
              {targets.length === 0 && (
                <p className="px-3 py-4 text-xs text-muted-foreground">{t('xray.bulk_relay_dialog.no_eligible_servers', 'No eligible servers.')}</p>
              )}
              {targets.map((s) => {
                const checked = selected.has(s.id)
                const d = drafts.get(s.id)
                const taken = portsByServer.get(s.id) ?? new Set<number>()
                return (
                  <label key={s.id}
                    className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 text-sm">
                    <input type="checkbox" checked={checked} onChange={() => toggle({ id: s.id, name: s.name })}
                      aria-label={`select ${s.name}`} />
                    <span className="font-mono w-32 truncate">{s.name}</span>
                    {taken.size > 0 && (
                      <span className="text-fg-dim text-2xs" title={t('xray.bulk_relay_dialog.ports_in_use_title', 'used: {{ports}}', { ports: Array.from(taken).join(', ') })}>
                        {t('xray.bulk_relay_dialog.ports_in_use', '{{n}} port(s) in use', { n: taken.size })}
                      </span>
                    )}
                    {checked && d && (
                      <>
                        <span className="font-mono text-fg-dim">{t('xray.bulk_relay_dialog.port_label', 'port')}</span>
                        <Input type="number" value={d.port}
                          onChange={(e) => setDrafts((prev) => {
                            const m = new Map(prev); m.set(s.id, { ...d, port: Number(e.target.value) }); return m
                          })}
                          className="h-7 w-24 font-mono" />
                        {needsX25519(proto) && (
                          <>
                            <Button size="xs" variant="ghost" className="text-2xs"
                              onClick={(e) => { e.preventDefault(); void regenKeys(s.id) }}>{t('xray.bulk_relay_dialog.regen_keys', '↻ keys')}</Button>
                            <span className="font-mono text-fg-dim text-2xs truncate" title={d.publicKey}>
                              {d.publicKey ? d.publicKey.slice(0, 8) + '…' : t('xray.bulk_relay_dialog.generating_key', 'generating…')}
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </label>
                )
              })}
            </div>
          </div>

          {version && <p className="text-fg-dim text-2xs">{t('xray.bulk_relay_dialog.version_note', "Uses xray v{{version}} (taken from the landing's deployed version).", { version })}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button disabled={deploy.isPending || selected.size === 0}
            onClick={() => deploy.mutate()}>
            {deploy.isPending ? t('xray.bulk_relay_dialog.deploying', 'Deploying…') : t('xray.bulk_relay_dialog.deploy_all', 'Deploy all ({{n}})', { n: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
