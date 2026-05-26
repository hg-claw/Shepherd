import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, RotateCw, Server, Trash2 } from 'lucide-react'
import { useServers } from '@/api/servers'
import { listXrayInbounds, listSingboxInbounds } from '@/api/plugins'
import {
  listSubgenSubscriptions,
  listSubgenTemplates,
  createSubgenSubscription,
  updateSubgenSubscription,
  deleteSubgenSubscription,
  rotateSubgenToken,
  getSubgenInbounds,
  setSubgenInbounds,
  type SubgenSubscription,
  type SubgenTemplate,
  type SubgenSelection,
} from '@/api/subgen'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useUI } from '@/store/ui'
import { copyText } from '@/lib/clipboard'

type Target = 'surge' | 'shadowrocket'

function subUrl(token: string, target: Target): string {
  return `${location.origin}/sub/${token}?target=${target}`
}

export default function SubscriptionsTab() {
  const toast = useUI((s) => s.toast)
  const qc = useQueryClient()

  const subsQ = useQuery({
    queryKey: ['subgen-subscriptions'],
    queryFn: listSubgenSubscriptions,
  })
  const tplQ = useQuery({
    queryKey: ['subgen-templates'],
    queryFn: listSubgenTemplates,
  })
  const templates = tplQ.data ?? []
  const tplName = (id: number) => templates.find((t) => t.id === id)?.name ?? `#${id}`

  const invalidate = () => qc.invalidateQueries({ queryKey: ['subgen-subscriptions'] })

  const create = useMutation({
    mutationFn: ({ name, template_id }: { name: string; template_id: number }) =>
      createSubgenSubscription(name, template_id),
    onSuccess: () => { invalidate(); toast('success', 'Subscription created') },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  const update = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Parameters<typeof updateSubgenSubscription>[1] }) =>
      updateSubgenSubscription(id, body),
    onSuccess: invalidate,
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  const remove = useMutation({
    mutationFn: deleteSubgenSubscription,
    onSuccess: invalidate,
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })
  const rotate = useMutation({
    mutationFn: rotateSubgenToken,
    onSuccess: () => { invalidate(); toast('success', 'Token rotated') },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  // per-row display target (surge/shadowrocket)
  const [targets, setTargets] = useState<Record<number, Target>>({})
  const targetOf = (id: number): Target => targets[id] ?? 'surge'

  const [creating, setCreating] = useState(false)
  const [nodesFor, setNodesFor] = useState<SubgenSubscription | null>(null)

  const copy = async (text: string) => {
    try {
      await copyText(text)
      toast('success', 'Copied to clipboard')
    } catch {
      toast('error', 'Copy failed')
    }
  }

  const subs = subsQ.data ?? []

  if (subsQ.isError) {
    return <div className="text-err text-[13px]">Failed to load subscriptions: {(subsQ.error as Error).message}</div>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-muted-foreground">
          Each subscription exposes a public URL clients import. Pick its template and the inbound nodes it bundles.
        </p>
        <Button size="sm" className="h-8" onClick={() => setCreating(true)} disabled={templates.length === 0}>
          <Plus className="h-3.5 w-3.5 mr-1" /> New subscription
        </Button>
      </div>

      <div className="rounded-lg border bg-elev overflow-x-auto">
        <table className="w-full text-[13px] border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Name</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Template</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Enabled</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">Subscription URL</th>
              <th className="px-3 py-2 text-[11px] uppercase tracking-[0.05em] text-muted-foreground text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => {
              const target = targetOf(s.id)
              const url = subUrl(s.token, target)
              return (
                <tr key={s.id} className="border-t align-top">
                  <td className="px-3 py-2 font-mono">{s.name}</td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground">{tplName(s.template_id)}</td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={s.enabled}
                      disabled={update.isPending}
                      onChange={(e) => update.mutate({ id: s.id, body: { enabled: e.target.checked } })}
                      aria-label="enabled"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <select
                        value={target}
                        onChange={(e) => setTargets((t) => ({ ...t, [s.id]: e.target.value as Target }))}
                        className="h-7 px-1.5 rounded border bg-background text-[11.5px]"
                      >
                        <option value="surge">surge</option>
                        <option value="shadowrocket">shadowrocket</option>
                      </select>
                      <code className="font-mono text-[11px] text-fg-dim truncate max-w-[22rem]">{url}</code>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0"
                        onClick={() => copy(url)} aria-label="copy url">
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button variant="outline" size="sm" className="h-7 px-2 text-[12px] mr-1"
                      onClick={() => setNodesFor(s)}>
                      <Server className="h-3.5 w-3.5 mr-1" /> Edit nodes
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 px-2 text-[12px] mr-1"
                      disabled={rotate.isPending}
                      onClick={() => rotate.mutate(s.id)}>
                      <RotateCw className="h-3.5 w-3.5 mr-1" /> Rotate token
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0"
                      disabled={remove.isPending}
                      onClick={() => { if (confirm(`Delete subscription "${s.name}"?`)) remove.mutate(s.id) }}
                      aria-label="delete">
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </td>
                </tr>
              )
            })}
            {subs.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-muted-foreground">No subscriptions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {creating && (
        <NewSubscriptionDialog
          templates={templates}
          pending={create.isPending}
          onClose={() => setCreating(false)}
          onCreate={(name, template_id) =>
            create.mutate({ name, template_id }, { onSuccess: () => setCreating(false) })
          }
        />
      )}

      {nodesFor && (
        <NodePickerDialog
          subscription={nodesFor}
          onClose={() => setNodesFor(null)}
        />
      )}
    </div>
  )
}

// ── New subscription dialog ─────────────────────────────────────────────────────

function NewSubscriptionDialog({
  templates, pending, onClose, onCreate,
}: {
  templates: SubgenTemplate[]
  pending: boolean
  onClose: () => void
  onCreate: (name: string, template_id: number) => void
}) {
  const [name, setName] = useState('')
  const [tpl, setTpl] = useState<number>(templates[0]?.id ?? 0)

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New subscription</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-[12px]">Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="my-phone" className="h-8 mt-1" />
          </div>
          <div>
            <Label className="text-[12px]">Template</Label>
            <select value={tpl} onChange={(e) => setTpl(Number(e.target.value))}
              className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] w-full">
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{t.builtin ? ' (built-in)' : ''}</option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!name.trim() || !tpl || pending}
            onClick={() => onCreate(name.trim(), tpl)}>Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Node picker dialog ──────────────────────────────────────────────────────────

function selKey(s: SubgenSelection) {
  return `${s.source}:${s.inbound_id}`
}

function NodePickerDialog({
  subscription, onClose,
}: {
  subscription: SubgenSubscription
  onClose: () => void
}) {
  const toast = useUI((s) => s.toast)
  const qc = useQueryClient()
  const serversQ = useServers()

  // All inbounds across servers — one query each (filtered by server_id is
  // also fine, but the unfiltered list already carries server_id/server_name).
  const xrayQ = useQuery({
    queryKey: ['subgen-picker-xray'],
    queryFn: () => listXrayInbounds(),
  })
  const singboxQ = useQuery({
    queryKey: ['subgen-picker-singbox'],
    queryFn: () => listSingboxInbounds(),
  })
  const currentQ = useQuery({
    queryKey: ['subgen-inbounds', subscription.id],
    queryFn: () => getSubgenInbounds(subscription.id),
  })

  const [selected, setSelected] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (currentQ.data) setSelected(new Set(currentQ.data.map(selKey)))
  }, [currentQ.data])

  const toggle = (s: SubgenSelection) => {
    const k = selKey(s)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }

  const save = useMutation({
    mutationFn: () => {
      const sels: SubgenSelection[] = [...selected].map((k) => {
        const [source, id] = k.split(':')
        return { source: source as SubgenSelection['source'], inbound_id: Number(id) }
      })
      return setSubgenInbounds(subscription.id, sels)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['subgen-inbounds', subscription.id] })
      toast('success', 'Nodes saved')
      onClose()
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  const loading = serversQ.isLoading || xrayQ.isLoading || singboxQ.isLoading || currentQ.isLoading

  // Group inbounds by server_id for rendering.
  const xrayByServer = new Map<number, { id: number; tag: string; protocol: string; port: number }[]>()
  for (const ib of xrayQ.data ?? []) {
    const arr = xrayByServer.get(ib.server_id) ?? []
    arr.push({ id: ib.id, tag: ib.tag, protocol: ib.protocol, port: ib.port })
    xrayByServer.set(ib.server_id, arr)
  }
  const singboxByServer = new Map<number, { id: number; tag: string; protocol: string; port: number }[]>()
  for (const ib of singboxQ.data ?? []) {
    const arr = singboxByServer.get(ib.server_id) ?? []
    arr.push({ id: ib.id, tag: ib.tag, protocol: ib.protocol, port: ib.port })
    singboxByServer.set(ib.server_id, arr)
  }

  const servers = serversQ.data ?? []

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Nodes for "{subscription.name}"</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-4">
          {loading && <div className="text-[12.5px] text-muted-foreground">Loading inbounds…</div>}
          {!loading && servers.map((srv) => {
            const xib = xrayByServer.get(srv.id) ?? []
            const sib = singboxByServer.get(srv.id) ?? []
            if (xib.length === 0 && sib.length === 0) return null
            return (
              <div key={srv.id} className="rounded-md border bg-sunken/30 p-3">
                <div className="font-mono text-[12.5px] mb-2">{srv.name}</div>
                <div className="space-y-1">
                  {xib.map((ib) => {
                    const sel: SubgenSelection = { source: 'xray', inbound_id: ib.id }
                    return (
                      <label key={`x${ib.id}`} className="flex items-center gap-2 text-[12.5px] cursor-pointer">
                        <input type="checkbox"
                          checked={selected.has(selKey(sel))}
                          onChange={() => toggle(sel)} />
                        <span className="text-[10px] uppercase rounded bg-muted px-1 py-0.5 text-muted-foreground">xray</span>
                        <span className="font-mono">{ib.tag}</span>
                        <span className="text-fg-dim text-[11px]">{ib.protocol} :{ib.port}</span>
                      </label>
                    )
                  })}
                  {sib.map((ib) => {
                    const sel: SubgenSelection = { source: 'singbox', inbound_id: ib.id }
                    return (
                      <label key={`s${ib.id}`} className="flex items-center gap-2 text-[12.5px] cursor-pointer">
                        <input type="checkbox"
                          checked={selected.has(selKey(sel))}
                          onChange={() => toggle(sel)} />
                        <span className="text-[10px] uppercase rounded bg-muted px-1 py-0.5 text-muted-foreground">singbox</span>
                        <span className="font-mono">{ib.tag}</span>
                        <span className="text-fg-dim text-[11px]">{ib.protocol} :{ib.port}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {!loading && (xrayQ.data ?? []).length === 0 && (singboxQ.data ?? []).length === 0 && (
            <div className="text-[12.5px] text-muted-foreground">
              No xray or sing-box inbounds exist yet. Create some on those plugins first.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={save.isPending || loading}
            onClick={() => save.mutate()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
