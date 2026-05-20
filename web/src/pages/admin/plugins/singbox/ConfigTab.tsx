import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { patchSingboxServerVersion, fetchSingboxVersions } from '@/api/plugins'
import { useServers } from '@/api/servers'

interface VersionsResponse {
  cached: Array<{ version: string; os: string; arch: string }>
  latest: string[]
}

export default function ConfigTab() {
  const qc = useQueryClient()
  const { data: servers = [] } = useServers()
  const { data: versions } = useQuery<VersionsResponse>({
    queryKey: ['singbox', 'versions'],
    queryFn: fetchSingboxVersions,
  })
  const [selected, setSelected] = useState<Record<number, string>>({})
  const deploy = useMutation({
    mutationFn: ({ serverID, version }: { serverID: number; version: string }) =>
      patchSingboxServerVersion(serverID, version),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['singbox'] }),
  })

  const allVersions = Array.from(new Set([
    ...(versions?.latest ?? []),
    ...(versions?.cached?.map(c => c.version) ?? []),
  ]))

  return (
    <div className="space-y-4 p-4">
      <h2 className="text-lg font-semibold">sing-box Binary Version</h2>
      {servers.map(s => (
        <div key={s.id} className="flex items-center gap-3">
          <span className="w-40 truncate text-sm">{s.name}</span>
          <Select
            value={selected[s.id] ?? ''}
            onValueChange={v => setSelected(prev => ({ ...prev, [s.id]: v }))}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="pick version" />
            </SelectTrigger>
            <SelectContent>
              {allVersions.map(v => (
                <SelectItem key={v} value={v}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!selected[s.id] || deploy.isPending}
            onClick={() => deploy.mutate({ serverID: s.id, version: selected[s.id] })}
          >
            Deploy
          </Button>
        </div>
      ))}
    </div>
  )
}
