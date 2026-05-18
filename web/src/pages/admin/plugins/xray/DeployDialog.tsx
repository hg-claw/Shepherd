// web/src/pages/admin/plugins/xray/DeployDialog.tsx
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useServers } from '@/api/servers'
import {
  deployPluginHost,
  fetchXrayVersions,
  generateX25519,
  generateShortID,
  getPluginConfig,
} from '@/api/plugins'
import { renderTemplate, parseConfig, randomPort, randomUUID, type Inbound } from './templates'
import type { PluginHost } from '@/api/plugins'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultServerID?: number
  existing?: PluginHost          // when set, the dialog opens in Re-deploy mode
}

export default function DeployDialog({ open, onOpenChange, defaultServerID, existing }: Props) {
  const qc = useQueryClient()
  const serversQ = useServers()
  const versionsQ = useQuery({
    queryKey: ['xray-versions'],
    queryFn: fetchXrayVersions,
    enabled: open,
  })

  const cfgQ = useQuery({
    queryKey: ['plugin-cfg', 'xray'],
    queryFn: () => getPluginConfig('xray'),
    enabled: open,
  })

  // Lazy-init every form field from `existing` on first render. Avoids the
  // bug where a useState default (e.g. randomUUID()) lands in state before
  // an async hydration useEffect runs, and a Re-deploy quietly rotates the
  // UUID / overwrites the SNI. Each useState initializer only runs once,
  // and the dialog is conditionally mounted by the parent, so changing
  // `existing` happens via remount (state is rebuilt from new props).
  const parsed = existing ? parseConfig(existing.config) : {}
  const [serverID, setServerID] = useState<number | ''>(existing?.server_id ?? defaultServerID ?? '')
  const [version, setVersion] = useState(existing?.deployed_version ?? '')
  const [inbound, setInbound] = useState<Inbound>(parsed.inbound ?? 'vless-reality')
  const [port, setPort] = useState<number>(parsed.port ?? 443)
  const [uuid, setUuid] = useState<string>(parsed.uuid ?? randomUUID())
  const [sni, setSni] = useState(parsed.sni ?? 'www.microsoft.com')
  const [publicKey, setPublicKey] = useState(parsed.publicKey ?? '')
  const [privateKey, setPrivateKey] = useState(parsed.privateKey ?? '')
  const [shortID, setShortID] = useState(parsed.shortID ?? '')
  const [wsPath, setWsPath] = useState(parsed.wsPath ?? '/ws')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (version) return
    if (versionsQ.data?.latest?.length) {
      setVersion(versionsQ.data.latest[0]); return
    }
    const dv = cfgQ.data?.default_version
    if (typeof dv === 'string' && dv) setVersion(dv)
  }, [version, versionsQ.data, cfgQ.data])

  const selectedServer = (serversQ.data ?? []).find((s) => s.id === serverID)

  const m = useMutation({
    mutationFn: async () => {
      if (!serverID) throw new Error('select a server')
      const config = renderTemplate({
        inbound, port, uuid,
        sni, publicKey, privateKey, shortID,
        wsPath,
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
          <DialogTitle className="font-mono">
            {existing ? 'Re-deploy xray' : 'Deploy xray'}
            {selectedServer ? ` → ${selectedServer.name}` : ''}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* Target server */}
          <div>
            <Label className="text-[12px]">Target server</Label>
            <select
              value={serverID}
              onChange={(e) => setServerID(Number(e.target.value) || '')}
              className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full"
            >
              <option value="">— select —</option>
              {(serversQ.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Version */}
            <div>
              <Label className="text-[12px]">Version</Label>
              {(versionsQ.data?.latest?.length ?? 0) > 0 ? (
                <select
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full"
                >
                  {versionsQ.data!.latest.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <Input
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  placeholder="1.8.11"
                  className="h-8 font-mono mt-1"
                />
              )}
              {!version && (
                <p className="text-err text-[11.5px] mt-1">
                  No xray version available. Set one in the Config tab or type it manually below.
                </p>
              )}
            </div>

            {/* Inbound protocol */}
            <div>
              <Label className="text-[12px]">Inbound protocol</Label>
              <select
                value={inbound}
                onChange={(e) => setInbound(e.target.value as Inbound)}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full"
              >
                <option value="vless-reality">VLESS + REALITY</option>
                <option value="vmess-ws">VMess + WebSocket</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Port */}
            <div>
              <Label className="text-[12px]">Port</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  className="h-8 font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-[12px]"
                  onClick={() => setPort(randomPort())}
                >
                  random
                </Button>
              </div>
            </div>

            {/* UUID */}
            <div>
              <Label className="text-[12px]">UUID</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  value={uuid}
                  onChange={(e) => setUuid(e.target.value)}
                  className="h-8 font-mono text-[12px]"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-[12px]"
                  onClick={() => setUuid(randomUUID())}
                >
                  new
                </Button>
              </div>
            </div>
          </div>

          {/* REALITY-specific fields */}
          {inbound === 'vless-reality' && (
            <>
              <div>
                <Label className="text-[12px]">REALITY SNI (target domain)</Label>
                <Input
                  value={sni}
                  onChange={(e) => setSni(e.target.value)}
                  placeholder="www.microsoft.com"
                  className="h-8 font-mono mt-1"
                />
              </div>

              <div>
                <Label className="text-[12px]">REALITY keypair</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={privateKey}
                    placeholder="private"
                    readOnly
                    className="h-8 font-mono text-[11px]"
                  />
                  <Input
                    value={publicKey}
                    placeholder="public"
                    readOnly
                    className="h-8 font-mono text-[11px]"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 text-[12px]"
                    onClick={async () => {
                      const kp = await generateX25519()
                      setPrivateKey(kp.private_key)
                      setPublicKey(kp.public_key)
                    }}
                  >
                    Generate
                  </Button>
                </div>
              </div>

              <div>
                <Label className="text-[12px]">Short ID (hex)</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    value={shortID}
                    onChange={(e) => setShortID(e.target.value)}
                    placeholder="auto"
                    className="h-8 font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 px-2 text-[12px]"
                    onClick={async () => {
                      const r = await generateShortID()
                      setShortID(r.short_id)
                    }}
                  >
                    Generate
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* VMess+WS-specific fields */}
          {inbound === 'vmess-ws' && (
            <div>
              <Label className="text-[12px]">WebSocket path</Label>
              <Input
                value={wsPath}
                onChange={(e) => setWsPath(e.target.value)}
                placeholder="/ws"
                className="h-8 font-mono mt-1"
              />
            </div>
          )}

          {error && <p className="text-err text-[12px]">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !version || !serverID}>
            {m.isPending
              ? (existing ? 'Re-deploying…' : 'Deploying…')
              : (existing ? 'Re-deploy' : 'Deploy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
