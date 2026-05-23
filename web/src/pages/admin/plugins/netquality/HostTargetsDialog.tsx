import { useEffect, useMemo, useState } from 'react'
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

const ISP_LABEL: Record<NetqualityISP, string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  overseas: '海外',
}

export default function HostTargetsDialog({ open, onOpenChange, serverID, serverName }: Props) {
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
      toast('success', 'Targets updated')
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
          <DialogTitle className="text-[14px]">
            Targets for <span className="font-mono">{serverName}</span>
          </DialogTitle>
        </DialogHeader>

        {q.isLoading && <div className="py-6 text-[12.5px] text-muted-foreground">Loading…</div>}

        {!q.isLoading && (
          <div className="space-y-3">
            <div className="text-[12px] text-muted-foreground">
              Pick which targets this server should ping. Disabling a target here just opts THIS
              host out — the catalog stays unchanged.
            </div>
            {(['telecom', 'unicom', 'mobile', 'overseas'] as NetqualityISP[]).map((isp) => {
              const rows = grouped.get(isp) ?? []
              if (rows.length === 0) return null
              const allSelected = rows.every((r) => selected.has(r.target_id))
              const someSelected = !allSelected && rows.some((r) => selected.has(r.target_id))
              return (
                <div key={isp} className="border rounded-md overflow-hidden">
                  <div
                    className="flex items-center justify-between px-3 py-1.5 bg-elev border-b cursor-pointer text-[12px] font-medium"
                    onClick={() => toggleGroup(isp)}
                  >
                    <span>
                      {ISP_LABEL[isp]}{' '}
                      <span className="text-muted-foreground">({rows.filter((r) => selected.has(r.target_id)).length}/{rows.length})</span>
                    </span>
                    <span className="text-[11px] text-muted-foreground">
                      {allSelected ? 'click to clear group' : someSelected ? 'partial — click to select all' : 'click to select all'}
                    </span>
                  </div>
                  <div className="divide-y">
                    {rows.map((r) => {
                      const checked = selected.has(r.target_id)
                      return (
                        <label
                          key={r.target_id}
                          className="flex items-center gap-3 px-3 py-1.5 text-[12.5px] cursor-pointer hover:bg-sunken"
                        >
                          <Switch checked={checked} onCheckedChange={() => toggle(r.target_id)} />
                          <span className="w-24 text-muted-foreground">{r.region}</span>
                          <span className="flex-1">{r.label}</span>
                          <span className="font-mono text-[11px] text-fg-dim">{r.host}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )
            })}

            <div className="flex items-center justify-between pt-2 border-t">
              <span className="text-[12px] text-muted-foreground">
                {selected.size} selected
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
