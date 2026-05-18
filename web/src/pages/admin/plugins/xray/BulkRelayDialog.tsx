import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useServers } from '@/api/servers'
import {
  deployPluginHost, fetchXrayVersions, generateX25519, generateShortID,
  type PluginHost,
} from '@/api/plugins'
import { useUI } from '@/store/ui'
import { renderTemplate, parseConfig, randomPort, randomUUID, type LandingRef } from './templates'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  landing: PluginHost
  landingServerHost: string  // landing's servers.ssh_host (must be Valid before opening)
  landingServerName: string  // landing's servers.name
  existingXrayServerIDs: Set<number>  // any server that already has xray (incl. landing itself)
}

interface RelayDraft {
  serverID: number
  serverName: string
  port: number
  uuid: string
  privateKey: string
  publicKey: string
  shortID: string
}

function newDraft(serverID: number, serverName: string): RelayDraft {
  return {
    serverID, serverName,
    port: randomPort(),
    uuid: randomUUID(),
    privateKey: '', publicKey: '', shortID: '',
  }
}

export default function BulkRelayDialog({
  open, onOpenChange, landing, landingServerHost, landingServerName, existingXrayServerIDs,
}: Props) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const versionsQ = useQuery({ queryKey: ['xray-versions'], queryFn: fetchXrayVersions, enabled: open })

  // Landing reference derived from landing.config (parsed once).
  const landingRef: LandingRef | null = useMemo(() => {
    const p = parseConfig(landing.config)
    if (!p.uuid || !p.publicKey || !p.sni || !p.port) return null
    return {
      address: landingServerHost,
      port: p.port,
      sni: p.sni,
      uuid: p.uuid,
      publicKey: p.publicKey,
      shortID: p.shortID ?? '',
    }
  }, [landing, landingServerHost])

  // Eligible targets: enrolled servers without xray, excluding landing itself.
  const targets = useMemo(() => {
    return (serversQ.data ?? []).filter((s) => !existingXrayServerIDs.has(s.id))
  }, [serversQ.data, existingXrayServerIDs])

  // Per-target draft state, keyed by server id.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [drafts, setDrafts] = useState<Map<number, RelayDraft>>(new Map())
  // Seed from landing's deployed version so the button is enabled before the
  // versions query resolves. The query result will override on first render
  // where data is available.
  const [version, setVersion] = useState<string>(landing.deployed_version ?? '')
  const [sharedSNI, setSharedSNI] = useState<string>(landingRef?.sni ?? 'www.icloud.com')

  // Prefer the latest available version once the query resolves.
  if (versionsQ.data?.latest?.length && versionsQ.data.latest[0] !== version) {
    setVersion(versionsQ.data.latest[0])
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

  const toggle = (s: { id: number; name: string }) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(s.id)) {
        next.delete(s.id)
        setDrafts((dPrev) => { const d = new Map(dPrev); d.delete(s.id); return d })
      } else {
        next.add(s.id)
        setDrafts((dPrev) => { const d = new Map(dPrev); d.set(s.id, newDraft(s.id, s.name)); return d })
        // Kick off key generation immediately when a server is selected.
        void regenKeys(s.id)
      }
      return next
    })
  }

  const deploy = useMutation({
    mutationFn: async () => {
      if (!landingRef) throw new Error('landing config incomplete')
      const ids = Array.from(selected.values()).sort((a, b) => a - b)
      let ok = 0, fail = 0
      // Take a snapshot of current drafts; we may update individual entries
      // below if keys haven't been generated yet (race between key-gen and
      // the user clicking Deploy All quickly).
      const draftSnapshot = new Map(drafts)
      for (const id of ids) {
        let d = draftSnapshot.get(id)!
        if (!d.privateKey || !d.publicKey || !d.shortID) {
          // Keys not ready yet — generate them inline now.
          try {
            const kp = await generateX25519()
            const sid = await generateShortID()
            d = { ...d, privateKey: kp.private_key, publicKey: kp.public_key, shortID: sid.short_id }
            // Update the real draft state so UI reflects generated keys.
            setDrafts((prev) => { const m = new Map(prev); m.set(id, d); return m })
          } catch (e: any) {
            fail++
            toast('error', `${d.serverName}: key generation failed, skipped`)
            continue
          }
        }
        const config = renderTemplate({
          inbound: 'vless-reality', port: d.port, uuid: d.uuid,
          sni: sharedSNI, publicKey: d.publicKey, privateKey: d.privateKey, shortID: d.shortID,
          role: 'relay',
          landing: { ...landingRef, sni: sharedSNI },
        })
        try {
          await deployPluginHost('xray', {
            server_id: id, version, config,
            topology: { role: 'relay', upstream_server_id: landing.server_id },
          })
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
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      qc.invalidateQueries({ queryKey: ['xray-topology'] })
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
          <DialogTitle className="font-mono">Add relays → {landingServerName}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Version</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)}
                className="h-8 font-mono mt-1" />
            </div>
            <div>
              <Label className="text-[12px]">REALITY SNI (shared)</Label>
              <Input value={sharedSNI} onChange={(e) => setSharedSNI(e.target.value)}
                className="h-8 font-mono mt-1" />
            </div>
          </div>

          <div>
            <Label className="text-[12px]">Target servers</Label>
            <div className="mt-1 rounded-md border bg-elev max-h-64 overflow-y-auto">
              {targets.length === 0 && (
                <p className="px-3 py-4 text-[12px] text-muted-foreground">
                  No eligible servers. All managed servers already have xray deployed, or none are enrolled.
                </p>
              )}
              {targets.map((s) => {
                const checked = selected.has(s.id)
                const d = drafts.get(s.id)
                return (
                  <label key={s.id}
                    className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 text-[12.5px]">
                    <input type="checkbox" checked={checked} onChange={() => toggle({ id: s.id, name: s.name })}
                      aria-label={`select ${s.name}`} />
                    <span className="font-mono w-32 truncate">{s.name}</span>
                    {checked && d && (
                      <>
                        <span className="font-mono text-fg-dim">port</span>
                        <Input type="number" value={d.port}
                          onChange={(e) => setDrafts((prev) => {
                            const m = new Map(prev); m.set(s.id, { ...d, port: Number(e.target.value) }); return m
                          })}
                          className="h-7 w-24 font-mono" />
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]"
                          onClick={(e) => { e.preventDefault(); void regenKeys(s.id) }}>
                          ↻ keys
                        </Button>
                        <span className="font-mono text-fg-dim text-[10px] truncate" title={d.publicKey}>
                          {d.publicKey ? d.publicKey.slice(0, 8) + '…' : 'generating…'}
                        </span>
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
          <Button
            disabled={deploy.isPending || selected.size === 0 || !landingRef || !version}
            onClick={() => deploy.mutate()}>
            {deploy.isPending ? 'Deploying…' : `Deploy all (${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
