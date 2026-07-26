import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  listHostTargets,
  updateHostTargets,
  type HostTargetRow,
  type NetqualityISP,
} from '@/api/netquality'
import { useUI } from '@/store/ui'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverID: number
  serverName: string
}

const ISP_LABEL_FALLBACK: Record<NetqualityISP, string> = {
  telecom: 'Telecom',
  unicom: 'Unicom',
  mobile: 'Mobile',
  overseas: 'Overseas',
}

export default function HostTargetsDialog({ open, onOpenChange, serverID, serverName }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)

  const q = useQuery({
    queryKey: ['netquality', 'host-targets', serverID],
    queryFn: () => listHostTargets(serverID),
    enabled: open,
  })

  // Local edits land into selectedIDs; we PUT the set on Save.
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // Sync local state from server data once on each open.
  useEffect(() => {
    if (q.data) {
      setSelected(new Set(q.data.filter((r) => r.selected).map((r) => r.target_id)))
    }
  }, [q.data])

  const grouped = useMemo(() => {
    const m = new Map<NetqualityISP, HostTargetRow[]>()
    for (const r of q.data ?? []) {
      const arr = m.get(r.isp) ?? []
      arr.push(r)
      m.set(r.isp, arr)
    }
    return m
  }, [q.data])

  const save = useMutation({
    mutationFn: () => updateHostTargets(serverID, Array.from(selected)),
    onSuccess: () => {
      toast('success', t('netquality.host_targets.updated_toast', 'Targets updated'))
      qc.invalidateQueries({ queryKey: ['netquality', 'host-targets', serverID] })
      qc.invalidateQueries({ queryKey: ['netquality', 'latest', serverID] })
      onOpenChange(false)
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleGroup = (isp: NetqualityISP) => {
    const rows = grouped.get(isp) ?? []
    const allSelected = rows.every((r) => selected.has(r.target_id))
    setSelected((prev) => {
      const next = new Set(prev)
      for (const r of rows) {
        if (allSelected) next.delete(r.target_id)
        else next.add(r.target_id)
      }
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">
            {t('netquality.host_targets.title', 'Targets for {{name}}', { name: serverName })}
          </DialogTitle>
        </DialogHeader>

        {q.isLoading && <div className="py-6 text-sm text-muted-foreground">{t('common.loading', 'Loading…')}</div>}

        {!q.isLoading && (
          <div className="space-y-3">
            <div className="text-xs text-muted-foreground">
              {t('netquality.host_targets.description', 'Pick which targets this server should ping. Disabling a target here just opts THIS host out — the catalog stays unchanged.')}
            </div>

            {(q.data ?? []).length === 0 && (
              <div className="text-xs text-muted-foreground">
                {t('netquality.host_targets.empty', 'No targets available yet.')}
              </div>
            )}

            {(['telecom', 'unicom', 'mobile', 'overseas'] as NetqualityISP[]).map((isp) => {
              const rows = grouped.get(isp) ?? []
              if (rows.length === 0) return null
              const allSelected = rows.every((r) => selected.has(r.target_id))
              const someSelected = !allSelected && rows.some((r) => selected.has(r.target_id))
              return (
                <div key={isp} className="border rounded-md overflow-hidden">
                  <div
                    className="flex items-center justify-between px-3 py-1.5 bg-elev border-b cursor-pointer text-xs font-medium"
                    onClick={() => toggleGroup(isp)}
                  >
                    <span>
                      {t(`netquality.isp.${isp}`, ISP_LABEL_FALLBACK[isp])}{' '}
                      <span className="text-muted-foreground">({rows.filter((r) => selected.has(r.target_id)).length}/{rows.length})</span>
                    </span>
                    <span className="text-2xs text-muted-foreground">
                      {allSelected
                        ? t('netquality.host_targets.clear_group', 'click to clear group')
                        : someSelected
                          ? t('netquality.host_targets.partial_group', 'partial — click to select all')
                          : t('netquality.host_targets.select_all_group', 'click to select all')}
                    </span>
                  </div>
                  <div className="divide-y">
                    {rows.map((r) => {
                      const checked = selected.has(r.target_id)
                      return (
                        <label
                          key={r.target_id}
                          className="flex items-center gap-3 px-3 py-1.5 text-sm cursor-pointer hover:bg-sunken"
                        >
                          <Switch checked={checked} onCheckedChange={() => toggle(r.target_id)} />
                          <span className="w-24 text-muted-foreground">{r.region}</span>
                          <span className="flex-1">{r.label}</span>
                          <span className="font-mono text-2xs text-fg-dim">{r.host}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            <div className="flex items-center justify-between pt-2 border-t">
              <span className="text-xs text-muted-foreground">
                {t('netquality.host_targets.selected_count', '{{count}} selected', { count: selected.size })}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? t('netquality.host_targets.saving', 'Saving…') : t('admin.save', 'Save')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
