import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getPluginConfig, putPluginConfig } from '@/api/plugins'
import { api } from '@/api/client'

export default function SetupTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugin-cfg', 'cloudflare'], queryFn: () => getPluginConfig('cloudflare') })
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => putPluginConfig('cloudflare', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-cfg', 'cloudflare'] }),
  })
  const [token, setToken] = useState('')
  const [accountID, setAccountID] = useState('')
  const [zoneID, setZoneID] = useState('')
  const [prefix, setPrefix] = useState('')
  useEffect(() => {
    if (q.data) {
      setToken(String(q.data.api_token ?? ''))
      setAccountID(String(q.data.account_id ?? ''))
      setZoneID(String(q.data.zone_id ?? ''))
      setPrefix(String(q.data.prefix ?? ''))
    }
  }, [q.data])

  // fetch zones once a token exists (the redaction sentinel still produces a valid auth header server-side)
  const zonesQ = useQuery({
    queryKey: ['cf-zones'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/api/admin/plugins/cloudflare/zones'),
    staleTime: 60_000,
    enabled: !!token,
  })

  return (
    <div className="max-w-md space-y-3">
      <div>
        <Label className="text-[12px]">API token</Label>
        <Input value={token} onChange={(e) => setToken(e.target.value)} className="h-8 font-mono mt-1" />
        <p className="text-fg-dim text-[11.5px] mt-1">
          Scoped token (Zone:Read + DNS:Edit). Stored on the server; never sent to the browser.
        </p>
      </div>
      <div>
        <Label className="text-[12px]">Account ID (optional)</Label>
        <Input value={accountID} onChange={(e) => setAccountID(e.target.value)} className="h-8 font-mono mt-1" />
      </div>
      <div>
        <Label className="text-[12px]">Default zone</Label>
        <select value={zoneID} onChange={(e) => setZoneID(e.target.value)}
          className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full">
          <option value="">— select a zone —</option>
          {(zonesQ.data ?? []).map((z) => (
            <option key={z.id} value={z.id}>{z.name} ({z.id.slice(0, 8)}…)</option>
          ))}
        </select>
        <p className="text-fg-dim text-[11.5px] mt-1">
          Default zone used for per-host domain mappings on the Hosts tab.
        </p>
      </div>
      <div>
        <Label className="text-[12px]">Subdomain prefix</Label>
        <Input value={prefix} onChange={(e) => setPrefix(e.target.value)}
          placeholder="hosts"
          className="h-8 font-mono mt-1" />
        <p className="text-fg-dim text-[11.5px] mt-1">
          Used when auto-generating per-host domains: <code>{'{server}.{prefix}.{zone}'}</code>.
        </p>
      </div>
      <Button size="sm" className="h-8" disabled={m.isPending}
        onClick={() => m.mutate({ api_token: token, account_id: accountID, zone_id: zoneID, prefix: prefix })}>
        Save
      </Button>
    </div>
  )
}
