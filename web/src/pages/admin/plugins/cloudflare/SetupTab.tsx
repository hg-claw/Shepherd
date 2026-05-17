import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { getPluginConfig, putPluginConfig } from '@/api/plugins'

export default function SetupTab() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['plugin-cfg', 'cloudflare'], queryFn: () => getPluginConfig('cloudflare') })
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => putPluginConfig('cloudflare', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['plugin-cfg', 'cloudflare'] }),
  })
  const [token, setToken] = useState('')
  const [accountID, setAccountID] = useState('')
  useEffect(() => {
    if (q.data) {
      setToken(String(q.data.api_token ?? ''))
      setAccountID(String(q.data.account_id ?? ''))
    }
  }, [q.data])
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
      <Button size="sm" className="h-8" disabled={m.isPending}
        onClick={() => m.mutate({ api_token: token, account_id: accountID })}>
        Save
      </Button>
    </div>
  )
}
