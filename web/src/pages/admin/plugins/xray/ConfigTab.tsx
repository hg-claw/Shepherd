import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getPluginConfig, putPluginConfig } from '@/api/plugins'

export default function ConfigTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugin-cfg', 'xray'], queryFn: () => getPluginConfig('xray') })
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => putPluginConfig('xray', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-cfg', 'xray'] }),
  })
  const [defaultVersion, setDefaultVersion] = useState('1.8.11')
  useEffect(() => {
    if (q.data?.default_version) setDefaultVersion(String(q.data.default_version))
  }, [q.data])
  return (
    <div className="max-w-md space-y-3">
      <div>
        <Label className="text-[12px]">Default version</Label>
        <Input
          value={defaultVersion}
          onChange={(e) => setDefaultVersion(e.target.value)}
          className="h-8 font-mono mt-1"
        />
        <p className="text-fg-dim text-[11.5px] mt-1">
          Used as the suggested version when deploying to a new host.
        </p>
      </div>
      <Button size="sm" className="h-8" disabled={m.isPending}
        onClick={() => m.mutate({ default_version: defaultVersion })}>
        Save
      </Button>
    </div>
  )
}
