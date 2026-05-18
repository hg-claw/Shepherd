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

  const [serverID, setServerID] = useState<number | ''>(defaultServerID ?? '')
  const [version, setVersion] = useState('')
  const [inbound, setInbound] = useState<Inbound>('vless-reality')
  const [port, setPort] = useState<number>(443)
  const [uuid, setUuid] = useState<string>(randomUUID())
  const [sni, setSni] = useState('www.microsoft.com')
  const [publicKey, setPublicKey] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [shortID, setShortID] = useState('')
  const [wsPath, setWsPath] = useState('/ws')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (defaultServerID != null) setServerID(defaultServerID)
  }, [defaultServerID])

  // re-hydrate when the dialog is opened for an existing deployment
  useEffect(() => {
    if (!open || !existing) return
    const parsed = parseConfig(existing.config)
    if (parsed.inbound) setInbound(parsed.inbound)
    if (typeof parsed.port === 'number') setPort(parsed.port)
    if (parsed.uuid) setUuid(parsed.uuid)
    if (parsed.sni) setSni(parsed.sni)
    if (parsed.publicKey) setPublicKey(parsed.publicKey)
    if (parsed.privateKey) setPrivateKey(parsed.privateKey)
    if (parsed.shortID) setShortID(parsed.shortID)
    if (parsed.wsPath) setWsPath(parsed.wsPath)
    if (existing.deployed_version) setVersion(existing.deployed_version)
    if (existing.server_id) setServerID(existing.server_id)
  }, [open, existing])

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
