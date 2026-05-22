import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useServers } from '@/api/servers'
import {
  createSingboxInbound, generateX25519, generateShortID,
  type SingboxInbound, type CreateSingboxInboundBody,
} from '@/api/plugins'
import { useUI } from '@/store/ui'
import { randomPort, randomUUID } from '../xray/templates'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  landingInbound: SingboxInbound
  allInbounds: SingboxInbound[]
}

// Generate a 32-character url-safe-base64 random password (no padding).
function randomPassword(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

interface RelayDraft {
  serverID: number
  serverName: string
  port: number
  // vless-reality specific
  uuid?: string
  privateKey?: string
  publicKey?: string
  shortID?: string
  // other protocols
  password?: string
}

function needsX25519(protocol: string): boolean {
  return protocol === 'vless-reality'
}

function newDraft(
  serverID: number,
  serverName: string,
  takenPorts: Set<number>,
  protocol: string,
): RelayDraft {
  let port = randomPort()
  while (takenPorts.has(port)) port = randomPort()
  const draft: RelayDraft = { serverID, serverName, port }

  if (protocol === 'vless-reality') {
    draft.uuid = randomUUID()
    draft.privateKey = ''
    draft.publicKey = ''
    draft.shortID = ''
  } else if (
    protocol === 'vless-ws-tls' || protocol === 'vless-h2-tls' || protocol === 'vless-httpupgrade-tls'
  ) {
    draft.uuid = randomUUID()
  } else if (
    protocol === 'vmess-tcp' || protocol === 'vmess-http' || protocol === 'vmess-quic' ||
    protocol === 'vmess-ws-tls' || protocol === 'vmess-h2-tls' || protocol === 'vmess-httpupgrade-tls'
  ) {
    draft.uuid = randomUUID()
  } else if (
    protocol === 'trojan-tls' || protocol === 'trojan-ws-tls' ||
    protocol === 'trojan-h2-tls' || protocol === 'trojan-httpupgrade-tls'
  ) {
    draft.password = randomPassword()
  } else if (protocol === 'hysteria2' || protocol === 'anytls') {
    draft.password = randomPassword()
  } else if (protocol === 'tuic-v5') {
    draft.uuid = randomUUID()
    draft.password = randomPassword()
  } else if (protocol === 'shadowsocks-2022') {
    draft.password = randomPassword()
  }

  return draft
}

// Build the createSingboxInbound body for a relay draft, inheriting
// protocol-specific fields from the landing.
function buildRelayBody(
  d: RelayDraft,
  landing: SingboxInbound,
): CreateSingboxInboundBody {
  const proto = landing.protocol
  const base: CreateSingboxInboundBody = {
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
      reality_public_key: d.publicKey,
      reality_private_key: d.privateKey,
      reality_short_id: d.shortID,
    }
  }

  if (
    proto === 'vless-ws-tls' || proto === 'vless-h2-tls' || proto === 'vless-httpupgrade-tls'
  ) {
    return {
      ...base,
      uuid: d.uuid,
      sni: landing.sni,
      transport_path: landing.transport_path,
      transport_host: landing.transport_host,
      cert_id: landing.cert_id ?? undefined,
    }
  }

  if (
    proto === 'vmess-tcp' || proto === 'vmess-http' || proto === 'vmess-quic' ||
    proto === 'vmess-ws-tls' || proto === 'vmess-h2-tls' || proto === 'vmess-httpupgrade-tls'
  ) {
    return {
      ...base,
      uuid: d.uuid,
      sni: landing.sni,
      transport_path: landing.transport_path,
      transport_host: landing.transport_host,
      alter_id: landing.alter_id,
      cert_id: landing.cert_id ?? undefined,
    }
  }

  if (
    proto === 'trojan-tls' || proto === 'trojan-ws-tls' ||
    proto === 'trojan-h2-tls' || proto === 'trojan-httpupgrade-tls'
  ) {
    return {
      ...base,
      password: d.password,
      sni: landing.sni,
      transport_path: landing.transport_path,
      transport_host: landing.transport_host,
      cert_id: landing.cert_id ?? undefined,
    }
  }

  if (proto === 'hysteria2' || proto === 'anytls') {
    return {
      ...base,
      password: d.password,
      sni: landing.sni,
      cert_id: landing.cert_id ?? undefined,
    }
  }

  if (proto === 'tuic-v5') {
    return {
      ...base,
      uuid: d.uuid,
      password: d.password,
      sni: landing.sni,
      cert_id: landing.cert_id ?? undefined,
    }
  }

  if (proto === 'shadowsocks-2022') {
    return {
      ...base,
      ss_password: d.password,
      ss_method: landing.ss_method,
    }
  }

  return base
}

export default function BulkRelayDialog({ open, onOpenChange, landingInbound, allInbounds }: Props) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
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

  // Exclude the landing's own server (don't put a relay back at its own landing).
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
          await createSingboxInbound(buildRelayBody(refresh, landingInbound))
          ok++
          toast('success', `Deployed relay on ${d.serverName}`)
        } catch (e: any) {
          fail++
          toast('error', `${d.serverName}: ${String(e?.message ?? e)}`)
        }
      }
      return { ok, fail }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['singbox', 'inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
    },
    onSuccess: ({ ok, fail }) => {
      toast(fail === 0 ? 'success' : 'info', `Bulk relay: ${ok} ok, ${fail} failed`)
      if (fail === 0) onOpenChange(false)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono">
            Add relays → {landingInbound.tag} @ {landingInbound.server_name}
          </DialogTitle>
          <p className="text-[12px] text-muted-foreground font-mono">{proto}</p>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="text-[12px]">Target servers</Label>
            <div className="mt-1 rounded-md border bg-elev max-h-64 overflow-y-auto">
              {targets.length === 0 && (
                <p className="px-3 py-4 text-[12px] text-muted-foreground">No eligible servers.</p>
              )}
              {targets.map((s) => {
                const checked = selected.has(s.id)
                const d = drafts.get(s.id)
                const taken = portsByServer.get(s.id) ?? new Set<number>()
                return (
                  <label key={s.id}
                    className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 text-[12.5px]">
                    <input type="checkbox" checked={checked} onChange={() => toggle({ id: s.id, name: s.name })}
                      aria-label={`select ${s.name}`} />
                    <span className="font-mono w-32 truncate">{s.name}</span>
                    {taken.size > 0 && (
                      <span className="text-fg-dim text-[10.5px]" title={`used: ${Array.from(taken).join(', ')}`}>
                        {taken.size} port(s) in use
                      </span>
                    )}
                    {checked && d && (
                      <>
                        <span className="font-mono text-fg-dim">port</span>
                        <Input type="number" value={d.port}
                          onChange={(e) => setDrafts((prev) => {
                            const m = new Map(prev); m.set(s.id, { ...d, port: Number(e.target.value) }); return m
                          })}
                          className="h-7 w-24 font-mono" />
                        {needsX25519(proto) && (
                          <>
                            <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]"
                              onClick={(e) => { e.preventDefault(); void regenKeys(s.id) }}>↻ keys</Button>
                            <span className="font-mono text-fg-dim text-[10px] truncate" title={d.publicKey}>
                              {d.publicKey ? d.publicKey.slice(0, 8) + '…' : 'generating…'}
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={deploy.isPending || selected.size === 0}
            onClick={() => deploy.mutate()}>
            {deploy.isPending ? 'Deploying…' : `Deploy all (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
