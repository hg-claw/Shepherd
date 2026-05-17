// web/src/pages/admin/plugins/xray/DeployDialog.tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { deployPluginHost } from '@/api/plugins'
import { renderTemplate, randomPort, randomUUID, type Inbound } from './templates'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverID: number
  serverName: string
  defaultVersion: string
}

export default function DeployDialog({ open, onOpenChange, serverID, serverName, defaultVersion }: Props) {
  const qc = useQueryClient()
  const [version, setVersion] = useState(defaultVersion)
  const [inbound, setInbound] = useState<Inbound>('vless-reality')
  const [port, setPort] = useState<number>(443)
  const [uuid, setUuid] = useState<string>(randomUUID())
  const [sni, setSni] = useState('www.microsoft.com')
  const [publicKey, setPublicKey] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [shortID, setShortID] = useState('')
  const [wsPath, setWsPath] = useState('/ws')
  const [method, setMethod] = useState('2022-blake3-aes-256-gcm')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  const m = useMutation({
    mutationFn: async () => {
      const config = renderTemplate({
        inbound, port, uuid,
        sni, publicKey, privateKey, shortID,
        wsPath,
        method, password,
      })
      return deployPluginHost('xray', { server_id: serverID, version, config })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      onOpenChange(false)
    },
    onError: (e: any) => setError(String(e?.message ?? e)),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono">Deploy xray → {serverName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Version</Label>
              <Input value={version} onChange={(e) => setVersion(e.target.value)}
                placeholder="1.8.11"
                className="h-8 font-mono mt-1" />
            </div>
            <div>
              <Label className="text-[12px]">Inbound protocol</Label>
              <select value={inbound} onChange={(e) => setInbound(e.target.value as Inbound)}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full">
                <option value="vless-reality">VLESS + REALITY</option>
                <option value="vmess-ws">VMess + WebSocket</option>
                <option value="shadowsocks">Shadowsocks-2022</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Port</Label>
              <div className="flex gap-2 mt-1">
                <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))}
                  className="h-8 font-mono" />
                <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-[12px]"
                  onClick={() => setPort(randomPort())}>
                  random
                </Button>
              </div>
            </div>
            {inbound !== 'shadowsocks' && (
              <div>
                <Label className="text-[12px]">UUID</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={uuid} onChange={(e) => setUuid(e.target.value)}
                    className="h-8 font-mono text-[12px]" />
                  <Button type="button" variant="outline" size="sm" className="h-8 px-2 text-[12px]"
                    onClick={() => setUuid(randomUUID())}>
                    new
                  </Button>
                </div>
              </div>
            )}
          </div>

          {inbound === 'vless-reality' && (
            <>
              <div>
                <Label className="text-[12px]">REALITY SNI (target domain)</Label>
                <Input value={sni} onChange={(e) => setSni(e.target.value)}
                  placeholder="www.microsoft.com"
                  className="h-8 font-mono mt-1" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[12px]">REALITY public key</Label>
                  <Input value={publicKey} onChange={(e) => setPublicKey(e.target.value)}
                    className="h-8 font-mono text-[12px] mt-1" />
                </div>
                <div>
                  <Label className="text-[12px]">REALITY private key</Label>
                  <Input value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
                    className="h-8 font-mono text-[12px] mt-1" />
                </div>
              </div>
              <div>
                <Label className="text-[12px]">Short ID (optional, hex)</Label>
                <Input value={shortID} onChange={(e) => setShortID(e.target.value)}
                  placeholder="00"
                  className="h-8 font-mono mt-1" />
              </div>
            </>
          )}

          {inbound === 'vmess-ws' && (
            <div>
              <Label className="text-[12px]">WebSocket path</Label>
              <Input value={wsPath} onChange={(e) => setWsPath(e.target.value)}
                placeholder="/ws"
                className="h-8 font-mono mt-1" />
            </div>
          )}

          {inbound === 'shadowsocks' && (
            <>
              <div>
                <Label className="text-[12px]">Encryption method</Label>
                <select value={method} onChange={(e) => setMethod(e.target.value)}
                  className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full">
                  <option>2022-blake3-aes-256-gcm</option>
                  <option>2022-blake3-aes-128-gcm</option>
                  <option>2022-blake3-chacha20-poly1305</option>
                  <option>aes-256-gcm</option>
                </select>
              </div>
              <div>
                <Label className="text-[12px]">Password</Label>
                <Input value={password} onChange={(e) => setPassword(e.target.value)}
                  className="h-8 font-mono mt-1" />
              </div>
            </>
          )}

          {error && <p className="text-err text-[12px]">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending}>
            {m.isPending ? 'Deploying…' : 'Deploy'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
