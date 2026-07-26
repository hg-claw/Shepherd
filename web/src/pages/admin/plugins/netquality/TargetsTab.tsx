import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/Pill'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  listNetqualityTargets,
  patchNetqualityTarget,
  createNetqualityTarget,
  deleteNetqualityTarget,
  type NetqualityISP,
  type NetqualityTarget,
} from '@/api/netquality'
import { useUI } from '@/store/ui'
import { ConfirmDialog } from '@/components/ConfirmDialog'

const ISP_LABEL_FALLBACK: Record<NetqualityISP, string> = {
  telecom: 'Telecom',
  unicom: 'Unicom',
  mobile: 'Mobile',
  overseas: 'Overseas',
}

export default function TargetsTab() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const targetsQ = useQuery({ queryKey: ['netquality', 'targets'], queryFn: listNetqualityTargets })
  const [removeTarget, setRemoveTarget] = useState<NetqualityTarget | null>(null)

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      patchNetqualityTarget(id, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['netquality', 'targets'] }),
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })
  const remove = useMutation({
    mutationFn: deleteNetqualityTarget,
    onSuccess: () => {
      toast('success', t('netquality.targets.removed_toast', 'Removed'))
      qc.invalidateQueries({ queryKey: ['netquality', 'targets'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })

  // Group by ISP for the rendered table. Builtins land first within
  // each group; custom rows appear at the bottom for visibility.
  const grouped = new Map<NetqualityISP, NetqualityTarget[]>()
  for (const tg of targetsQ.data ?? []) {
    const arr = grouped.get(tg.isp) ?? []
    arr.push(tg)
    grouped.set(tg.isp, arr)
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
      return a.label.localeCompare(b.label)
    })
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('netquality.targets.description', 'Toggle which destinations are sampled. Builtin entries can be disabled (history stays intact) but not deleted. Custom entries are scoped to your install.')}
      </p>

      <NewTargetForm />

      <ConfirmDialog
        open={removeTarget != null}
        onOpenChange={(open) => { if (!open) setRemoveTarget(null) }}
        title={t('netquality.delete_target')}
        description={t('netquality.delete_target_confirm', { name: removeTarget?.label ?? '' })}
        onConfirm={() => { if (removeTarget) remove.mutate(removeTarget.id) }}
      />

      {(targetsQ.data ?? []).length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t('netquality.empty.targets', 'No targets configured yet.')}
        </p>
      )}

      {(['telecom', 'unicom', 'mobile', 'overseas'] as NetqualityISP[]).map((isp) => {
        const rows = grouped.get(isp) ?? []
        if (rows.length === 0) return null
        return (
          <div key={isp} className="border rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-elev border-b text-xs font-medium">
              {t(`netquality.isp.${isp}`, ISP_LABEL_FALLBACK[isp])}{' '}
              <span className="text-muted-foreground">({rows.length})</span>
            </div>
            <Table wrapperClassName="border-0 rounded-none bg-transparent">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('netquality.targets.region', 'Region')}</TableHead>
                  <TableHead>{t('netquality.targets.label', 'Label')}</TableHead>
                  <TableHead className="font-mono">{t('netquality.targets.host', 'Host')}</TableHead>
                  <TableHead>{t('netquality.targets.source', 'Source')}</TableHead>
                  <TableHead>{t('netquality.targets.enabled', 'Enabled')}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((target) => (
                  <TableRow key={target.id}>
                    <TableCell>{target.region}</TableCell>
                    <TableCell>{target.label}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{target.host}</TableCell>
                    <TableCell>
                      <Pill kind={target.source === 'builtin' ? 'neutral' : 'ok'}>{target.source}</Pill>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={target.enabled}
                        disabled={toggle.isPending}
                        onCheckedChange={(v) => toggle.mutate({ id: target.id, enabled: v })}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      {target.source === 'custom' && (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="w-7 p-0"
                          disabled={remove.isPending}
                          onClick={() => setRemoveTarget(target)}
                          title={t('admin.delete', 'Delete')}
                        >
                          <Trash className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      })}
    </div>
  )
}

function NewTargetForm() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const [isp, setISP] = useState<NetqualityISP>('overseas')
  const [region, setRegion] = useState('')
  const [label, setLabel] = useState('')
  const [host, setHost] = useState('')
  const create = useMutation({
    mutationFn: createNetqualityTarget,
    onSuccess: () => {
      toast('success', t('netquality.targets.add_toast', 'Added'))
      setRegion(''); setLabel(''); setHost('')
      qc.invalidateQueries({ queryKey: ['netquality', 'targets'] })
    },
    onError: (e: unknown) => toast('error', String((e as Error)?.message ?? e)),
  })
  return (
    <div className="border rounded-md bg-elev p-3 flex items-center gap-2 flex-wrap">
      <Select value={isp} onValueChange={(v) => setISP(v as NetqualityISP)}>
        <SelectTrigger className="h-8 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(ISP_LABEL_FALLBACK) as NetqualityISP[]).map((k) => (
            <SelectItem key={k} value={k} className="text-xs">
              {t(`netquality.isp.${k}`, ISP_LABEL_FALLBACK[k])}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        className="h-8 w-36 text-xs"
        placeholder={t('netquality.targets.region_placeholder', 'Region (e.g. HK)')}
        value={region}
        onChange={(e) => setRegion(e.target.value)}
      />
      <Input
        className="h-8 w-48 text-xs"
        placeholder={t('netquality.targets.label_placeholder', 'Label (e.g. My VPS)')}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <Input
        className="h-8 w-48 text-xs font-mono"
        placeholder={t('netquality.targets.host_placeholder', 'Host or IP')}
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <Button
        size="sm"
        disabled={create.isPending || !host || !label}
        onClick={() => create.mutate({ isp, region, label, host })}
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        {t('netquality.targets.add_custom', 'Add custom')}
      </Button>
    </div>
  )
}
