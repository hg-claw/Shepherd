import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  listNetqualityTargets,
  patchNetqualityTarget,
  createNetqualityTarget,
  deleteNetqualityTarget,
  type NetqualityISP,
  type NetqualityTarget,
} from '@/api/netquality'
import { useUI } from '@/store/ui'

const ISP_LABEL: Record<NetqualityISP, string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  overseas: '海外',
}

export default function TargetsTab() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const targetsQ = useQuery({ queryKey: ['netquality', 'targets'], queryFn: listNetqualityTargets })

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      patchNetqualityTarget(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['netquality', 'targets'] }),
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })
  const remove = useMutation({
    mutationFn: deleteNetqualityTarget,
    onSuccess: () => {
      toast('success', 'Removed')
      qc.invalidateQueries({ queryKey: ['netquality', 'targets'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  // Group by ISP for the rendered table. Builtins land first within
  // each group; custom rows appear at the bottom for visibility.
  const grouped = new Map<NetqualityISP, NetqualityTarget[]>()
  for (const t of targetsQ.data ?? []) {
    const arr = grouped.get(t.isp) ?? []
    arr.push(t)
    grouped.set(t.isp, arr)
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
      return a.label.localeCompare(b.label)
    })
  }

  return (
    <div className="space-y-4">
      <div className="text-[12.5px] text-muted-foreground">
        Toggle which destinations are sampled. Builtin entries can be disabled (history stays
        intact) but not deleted. Custom entries are scoped to your install.
      </div>

      <NewTargetForm />

      {(['telecom', 'unicom', 'mobile', 'overseas'] as NetqualityISP[]).map((isp) => {
        const rows = grouped.get(isp) ?? []
        if (rows.length === 0) return null
        return (
          <div key={isp} className="border rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-elev border-b text-[12px] font-medium">
              {ISP_LABEL[isp]} <span className="text-muted-foreground">({rows.length})</span>
            </div>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b text-[11px] text-muted-foreground uppercase tracking-wide">
                  <th className="text-left py-2 pl-3 pr-4 font-medium">Region</th>
                  <th className="text-left py-2 pr-4 font-medium">Label</th>
                  <th className="text-left py-2 pr-4 font-medium font-mono">Host</th>
                  <th className="text-left py-2 pr-4 font-medium">Source</th>
                  <th className="text-left py-2 pr-4 font-medium">Enabled</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="border-b last:border-0">
                    <td className="py-2 pl-3 pr-4">{t.region}</td>
                    <td className="py-2 pr-4">{t.label}</td>
                    <td className="py-2 pr-4 font-mono text-[12px] text-muted-foreground">{t.host}</td>
                    <td className="py-2 pr-4">
                      <Pill kind={t.source === 'builtin' ? 'neutral' : 'ok'}>{t.source}</Pill>
                    </td>
                    <td className="py-2 pr-4">
                      <Switch
                        checked={t.enabled}
                        disabled={toggle.isPending}
                        onCheckedChange={(v) => toggle.mutate({ id: t.id, enabled: v })}
                      />
                    </td>
                    <td className="py-2 pr-3 text-right">
                      {t.source === 'custom' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (confirm(`Delete custom target "${t.label}"?`)) remove.mutate(t.id)
                          }}
                          title="Delete"
                        >
                          <Trash className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
    </div>
  )
}

function NewTargetForm() {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [isp, setISP] = useState<NetqualityISP>('overseas')
  const [region, setRegion] = useState('')
  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const create = useMutation({
    mutationFn: createNetqualityTarget,
    onSuccess: () => {
      toast('success', 'Added')
      setRegion(''); setLabel(''); setHost('')
      qc.invalidateQueries({ queryKey: ['netquality', 'targets'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })
  return (
    <div className="border rounded-md bg-elev p-3 flex items-center gap-2 flex-wrap">
      <Select value={isp} onValueChange={(v) => setISP(v as NetqualityISP)}>
        <SelectTrigger className="h-8 w-32 text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ISP_LABEL) as NetqualityISP[]).map((k) => (
            <SelectItem key={k} value={k} className="text-[12px]">
              {ISP_LABEL[k]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        className="h-8 w-36 text-[12px]"
        placeholder="Region (e.g. HK)"
        value={region}
        onChange={(e) => setRegion(e.target.value)}
      />
      <Input
        className="h-8 w-48 text-[12px]"
        placeholder="Label (e.g. My VPS)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <Input
        className="h-8 w-48 text-[12px] font-mono"
        placeholder="Host or IP"
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <Button
        size="sm"
        className="h-8"
        disabled={create.isPending || !host || !label}
        onClick={() => create.mutate({ isp, region, label, host })}
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        Add custom
      </Button>
    </div>
  )
}
