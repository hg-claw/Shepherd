import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fetchXrayVersions, getPluginConfig, putPluginConfig } from '@/api/plugins'

export default function ConfigTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugin-cfg', 'xray'], queryFn: () => getPluginConfig('xray') })
  const versionsQ = useQuery({
    queryKey: ['xray-versions'],
    queryFn: fetchXrayVersions,
  })
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => putPluginConfig('xray', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-cfg', 'xray'] }),
  })
  const [defaultVersion, setDefaultVersion] = useState('1.8.11')
  useEffect(() => {
    if (q.data?.default_version) setDefaultVersion(String(q.data.default_version))
  }, [q.data])

  const latest = versionsQ.data?.latest ?? []

  return (
    <div className="max-w-md space-y-3">
      <div>
        <Label className="text-[12px]">Default version</Label>
        {latest.length > 0 ? (
          <select
            value={defaultVersion}
            onChange={(e) => setDefaultVersion(e.target.value)}
            className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full max-w-xs"
          >
            {/* If the saved default isn't in `latest` (admin set an old pinned version),
                keep it visible as an extra option so the select reflects reality. */}
            {!latest.includes(defaultVersion) && defaultVersion && (
              <option value={defaultVersion}>{defaultVersion} (saved)</option>
            )}
            {latest.map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        ) : (
          <Input
            value={defaultVersion}
            onChange={(e) => setDefaultVersion(e.target.value)}
            placeholder="1.8.11"
            className="h-8 font-mono mt-1 max-w-xs"
          />
        )}
        <p className="text-fg-dim text-[11.5px] mt-1">
          Picked from the latest 5 GitHub releases (refreshed daily) — used as the suggested version when deploying.
        </p>
      </div>
      <Button size="sm" className="h-8" disabled={m.isPending}
        onClick={() => m.mutate({ default_version: defaultVersion })}>
        Save
      </Button>
    </div>
  )
}
