import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, RotateCw, Server, Trash2 } from 'lucide-react'
import { useServers } from '@/api/servers'
import { listXrayInbounds, listSingboxInbounds, listMieruInbounds } from '@/api/plugins'
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
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableEmpty } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { useUI } from '@/store/ui'
import { copyText } from '@/lib/clipboard'
import { ConfirmDialog } from '@/components/ConfirmDialog'

type Target = 'surge' | 'shadowrocket' | 'clash'

function subUrl(token: string, target: Target): string {
  return `${location.origin}/sub/${token}?target=${target}`
}

export default function SubscriptionsTab() {
  const { t } = useTranslation()
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
    onSuccess: () => { invalidate(); toast('success', t('subgen.subscriptions.created_toast', 'Subscription created')) },
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
    onSuccess: () => { invalidate(); toast('success', t('subgen.subscriptions.rotated_toast', 'Token rotated')) },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  // per-row display target (surge / shadowrocket / clash)
  const [targets, setTargets] = useState<Record<number, Target>>({})
  const targetOf = (id: number): Target => targets[id] ?? 'surge'

  const [creating, setCreating] = useState(false)
  const [nodesFor, setNodesFor] = useState<SubgenSubscription | null>(null)
  const [removeTarget, setRemoveTarget] = useState<SubgenSubscription | null>(null)

  const copy = async (text: string) => {
    try {
      await copyText(text)
      toast('success', t('common.copied'))
    } catch {
      toast('error', t('subgen.subscriptions.copy_failed_toast', 'Copy failed'))
    }
  }

  const subs = subsQ.data ?? []

  if (subsQ.isError) {
    return (
      <div className="text-err text-sm">
        {t('subgen.subscriptions.load_error', 'Failed to load subscriptions: {{message}}', {
          message: (subsQ.error as Error).message,
        })}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {t('subgen.subscriptions.description', 'Each subscription exposes a public URL clients import. Pick its template and the inbound nodes it bundles.')}
        </p>
        <Button size="sm" onClick={() => setCreating(true)} disabled={templates.length === 0}>
          <Plus className="h-3.5 w-3.5 mr-1" /> {t('subgen.subscriptions.new', 'New subscription')}
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('subgen.subscriptions.name', 'Name')}</TableHead>
            <TableHead>{t('subgen.subscriptions.template', 'Template')}</TableHead>
            <TableHead>{t('subgen.subscriptions.enabled', 'Enabled')}</TableHead>
            <TableHead>{t('subgen.subscriptions.url', 'Subscription URL')}</TableHead>
            <TableHead className="text-right">{t('admin.actions', 'Actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {subs.map((s) => {
            const target = targetOf(s.id)
            const url = subUrl(s.token, target)
            return (
              <TableRow key={s.id} className="align-top">
                <TableCell className="font-mono">{s.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{tplName(s.template_id)}</TableCell>
                <TableCell>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={update.isPending}
                    onChange={(e) => update.mutate({ id: s.id, body: { enabled: e.target.checked } })}
                    aria-label={t('subgen.subscriptions.enabled_aria', 'enabled')}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <select
                      value={target}
                      onChange={(e) => setTargets((t) => ({ ...t, [s.id]: e.target.value as Target }))}
                      className="h-7 px-1.5 rounded border bg-background text-2xs"
                    >
                      <option value="surge">surge</option>
                      <option value="shadowrocket">shadowrocket</option>
                      <option value="clash">clash</option>
                    </select>
                    <code className="font-mono text-2xs text-fg-dim truncate max-w-[22rem]">{url}</code>
                    <Button variant="ghost" size="xs" className="w-7 p-0"
                      onClick={() => copy(url)} aria-label={t('subgen.subscriptions.copy_url_aria', 'copy url')}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap">
                  <Button variant="outline" size="xs" className="mr-1"
                    onClick={() => setNodesFor(s)}>
                    <Server className="h-3.5 w-3.5 mr-1" /> {t('subgen.subscriptions.edit_nodes', 'Edit nodes')}
                  </Button>
                  <Button variant="outline" size="xs" className="mr-1"
                    disabled={rotate.isPending}
                    onClick={() => rotate.mutate(s.id)}>
                    <RotateCw className="h-3.5 w-3.5 mr-1" /> {t('subgen.subscriptions.rotate_token', 'Rotate token')}
                  </Button>
                  <Button variant="ghost" size="xs" className="w-7 p-0"
                    disabled={remove.isPending}
                    onClick={() => setRemoveTarget(s)}
                    aria-label={t('subgen.subscriptions.delete_aria', 'delete')}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            )
          })}
          {subs.length === 0 && (
            <TableEmpty colSpan={5}>{t('subgen.empty.subscriptions', 'No subscriptions yet.')}</TableEmpty>
          )}
        </TableBody>
      </Table>

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

      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}
        title={t('subgen.delete_subscription')}
        description={t('subgen.delete_subscription_confirm', { name: removeTarget?.name ?? '' })}
        onConfirm={() => { if (removeTarget) remove.mutate(removeTarget.id) }}
      />
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
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [tpl, setTpl] = useState<number>(templates[0]?.id ?? 0)

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('subgen.subscriptions.new', 'New subscription')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">{t('subgen.subscriptions.name', 'Name')}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)}
              placeholder={t('subgen.subscriptions.name_placeholder', 'my-phone')} className="h-8 mt-1" />
          </div>
          <div>
            <Label className="text-xs">{t('subgen.subscriptions.template', 'Template')}</Label>
            <select value={tpl} onChange={(e) => setTpl(Number(e.target.value))}
              className="mt-1 h-8 px-2 rounded-md border bg-background text-sm w-full">
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}{template.builtin ? ` ${t('subgen.subscriptions.builtin_suffix', '(built-in)')}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" disabled={!name.trim() || !tpl || pending}
            onClick={() => onCreate(name.trim(), tpl)}>{t('common.create')}</Button>
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
  const { t } = useTranslation()
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
  const mieruQ = useQuery({
    queryKey: ['subgen-picker-mieru'],
    queryFn: () => listMieruInbounds(),
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
      toast('success', t('subgen.subscriptions.save_nodes_toast', 'Nodes saved'))
      onClose()
    },
    onError: (e: any) => toast('error', String(e?.message ?? e)),
  })

  const loading = serversQ.isLoading || xrayQ.isLoading || singboxQ.isLoading || mieruQ.isLoading || currentQ.isLoading

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
  const mieruByServer = new Map<number, { id: number; tag: string; protocol: string; port: number }[]>()
  for (const ib of mieruQ.data ?? []) {
    const arr = mieruByServer.get(ib.server_id) ?? []
    arr.push({ id: ib.id, tag: ib.tag, protocol: ib.protocol, port: ib.port })
    mieruByServer.set(ib.server_id, arr)
  }

  const servers = serversQ.data ?? []

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('subgen.subscriptions.nodes_title', 'Nodes for "{{name}}"', { name: subscription.name })}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto space-y-4">
          {loading && <div className="text-sm text-muted-foreground">{t('subgen.subscriptions.loading_inbounds', 'Loading inbounds…')}</div>}
          {!loading && servers.map((srv) => {
            const xib = xrayByServer.get(srv.id) ?? []
            const sib = singboxByServer.get(srv.id) ?? []
            const mib = mieruByServer.get(srv.id) ?? []
            if (xib.length === 0 && sib.length === 0 && mib.length === 0) return null
            return (
              <div key={srv.id} className="rounded-md border bg-sunken/30 p-3">
                <div className="font-mono text-sm mb-2">{srv.name}</div>
                <div className="space-y-1">
                  {xib.map((ib) => {
                    const sel: SubgenSelection = { source: 'xray', inbound_id: ib.id }
                    return (
                      <label key={`x${ib.id}`} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox"
                          checked={selected.has(selKey(sel))}
                          onChange={() => toggle(sel)} />
                        <span className="text-2xs uppercase rounded bg-muted px-1 py-0.5 text-muted-foreground">xray</span>
                        <span className="font-mono">{ib.tag}</span>
                        <span className="text-fg-dim text-2xs">{ib.protocol} :{ib.port}</span>
                      </label>
                    )
                  })}
                  {sib.map((ib) => {
                    const sel: SubgenSelection = { source: 'singbox', inbound_id: ib.id }
                    return (
                      <label key={`s${ib.id}`} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox"
                          checked={selected.has(selKey(sel))}
                          onChange={() => toggle(sel)} />
                        <span className="text-2xs uppercase rounded bg-muted px-1 py-0.5 text-muted-foreground">singbox</span>
                        <span className="font-mono">{ib.tag}</span>
                        <span className="text-fg-dim text-2xs">{ib.protocol} :{ib.port}</span>
                      </label>
                    )
                  })}
                  {mib.map((ib) => {
                    const sel: SubgenSelection = { source: 'mieru', inbound_id: ib.id }
                    return (
                      <label key={`m${ib.id}`} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="checkbox"
                          checked={selected.has(selKey(sel))}
                          onChange={() => toggle(sel)} />
                        <span className="text-2xs uppercase rounded bg-muted px-1 py-0.5 text-muted-foreground">mieru</span>
                        <span className="font-mono">{ib.tag}</span>
                        <span className="text-fg-dim text-2xs">{ib.protocol} :{ib.port}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {!loading && (xrayQ.data ?? []).length === 0 && (singboxQ.data ?? []).length === 0 && (mieruQ.data ?? []).length === 0 && (
            <div className="text-sm text-muted-foreground">
              {t('subgen.subscriptions.no_inbounds', 'No xray, sing-box, or mieru inbounds exist yet. Create some on those plugins first.')}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" disabled={save.isPending || loading}
            onClick={() => save.mutate()}>{t('admin.save', 'Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
