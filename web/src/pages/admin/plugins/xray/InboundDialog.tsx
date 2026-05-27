import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useServers } from '@/api/servers'
import { useUI } from '@/store/ui'
import {
  createXrayInbound, patchXrayInbound, generateX25519, generateShortID,
  type XrayInbound,
} from '@/api/plugins'
import { randomPort, randomUUID, randomSSKey } from './templates'

const XRAY_SS_METHODS = [
  'aes-256-gcm', 'aes-128-gcm', 'chacha20-poly1305', 'xchacha20-poly1305',
  '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
]

type Role = 'landing' | 'relay'
type Protocol = 'vless-reality' | 'vmess-ws' | 'shadowsocks'

interface CreateProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create'
  defaultServerID?: number
  allInbounds: XrayInbound[]
}
interface EditProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'edit'
  inbound: XrayInbound
  allInbounds: XrayInbound[]
}
type Props = CreateProps | EditProps

export default function InboundDialog(props: Props) {
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const editing = props.mode === 'edit' ? props.inbound : null

  // Lazy-init from props (mount = once)
  const [serverID, setServerID] = useState<number | ''>(
    editing?.server_id ?? (props.mode === 'create' ? (props as CreateProps).defaultServerID : undefined) ?? ''
  )
  const [role, setRole] = useState<Role>(editing?.role ?? 'landing')
  const [protocol, setProtocol] = useState<Protocol>(editing?.protocol ?? 'vless-reality')
  const [upstreamID, setUpstreamID] = useState<number | ''>(editing?.upstream_inbound_id ?? '')
  const [port, setPort] = useState<number>(editing?.port ?? randomPort())
  const [uuid, setUUID] = useState<string>(editing?.uuid ?? randomUUID())
  const [sni, setSNI] = useState<string>(editing?.sni ?? 'www.lovelive-anime.jp')
  const [publicKey, setPublicKey] = useState<string>(editing?.public_key ?? '')
  const [privateKey, setPrivateKey] = useState<string>('') // never preloaded from edit (it's redacted)
  const [shortID, setShortID] = useState<string>(editing?.short_id ?? '')
  const [wsPath, setWSPath] = useState<string>(editing?.ws_path ?? '/ws')
  const [ssMethod, setSSMethod] = useState<string>(editing?.ss_method ?? 'aes-256-gcm')
  const [ssPassword, setSSPassword] = useState<string>('')
  const [alias, setAlias] = useState<string>(editing?.alias ?? '')
  const [error, setError] = useState<string | null>(null)

  const landings = props.allInbounds.filter((i) => i.role === 'landing')

  const create = useMutation({
    mutationFn: () => {
      if (!serverID) throw new Error('select a server')
      if (role === 'relay' && !upstreamID) throw new Error('relay requires upstream landing')
      return createXrayInbound({
        server_id: Number(serverID), port, alias: alias || undefined, role, protocol,
        uuid, sni, public_key: publicKey, private_key: privateKey, short_id: shortID,
        ws_path: protocol === 'vmess-ws' ? wsPath : undefined,
        ss_method: protocol === 'shadowsocks' ? ssMethod : undefined,
        ss_password: protocol === 'shadowsocks' ? ssPassword : undefined,
        upstream_inbound_id: role === 'relay' ? Number(upstreamID) : undefined,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      toast('success', 'Inbound created')
      props.onOpenChange(false)
    },
    onError: (e: any) => setError(String(e?.message ?? e)),
  })

  const patch = useMutation({
    mutationFn: () => {
      if (!editing) throw new Error('not in edit mode')
      return patchXrayInbound(editing.id, {
        port,
        alias: alias !== editing.alias ? alias : undefined,
        uuid: uuid !== editing.uuid ? uuid : undefined,
        sni: sni !== editing.sni ? sni : undefined,
        public_key: publicKey !== editing.public_key ? publicKey : undefined,
        private_key: privateKey || undefined,
        short_id: shortID !== editing.short_id ? shortID : undefined,
        ss_method: ssMethod !== editing.ss_method ? ssMethod : undefined,
        ss_password: ssPassword || undefined,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      toast('success', 'Inbound updated')
      props.onOpenChange(false)
    },
    onError: (e: any) => setError(String(e?.message ?? e)),
  })

  const isEdit = props.mode === 'edit'
  const submit = () => (isEdit ? patch.mutate() : create.mutate())

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {isEdit ? `Edit inbound ${editing!.tag}` : 'New inbound'}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]" htmlFor="ind-server">Server</Label>
              <select id="ind-server"
                aria-label="server"
                value={serverID}
                onChange={(e) => setServerID(Number(e.target.value) || '')}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="">— select —</option>
                {(serversQ.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-[12px]" htmlFor="ind-role">Role</Label>
              <select id="ind-role"
                aria-label="role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="landing">Landing</option>
                <option value="relay">Relay</option>
              </select>
            </div>
          </div>

          {role === 'relay' && (
            <div>
              <Label className="text-[12px]" htmlFor="ind-upstream">Upstream landing-inbound</Label>
              <select id="ind-upstream"
                aria-label="upstream landing-inbound"
                value={upstreamID}
                onChange={(e) => setUpstreamID(Number(e.target.value) || '')}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="">— select —</option>
                {landings.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.server_name} / {l.tag} (:{l.port})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Protocol</Label>
              <select value={protocol}
                onChange={(e) => setProtocol(e.target.value as Protocol)}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                <option value="vless-reality">VLESS + REALITY</option>
                <option value="vmess-ws">VMess + WS</option>
                <option value="shadowsocks">Shadowsocks</option>
              </select>
            </div>
            <div>
              <Label className="text-[12px]">Port</Label>
              <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))}
                className="h-8 font-mono mt-1" />
            </div>
          </div>

          {protocol !== 'shadowsocks' && (
            <div>
              <Label className="text-[12px]">UUID</Label>
              <div className="flex gap-2 mt-1">
                <Input value={uuid} onChange={(e) => setUUID(e.target.value)}
                  className="h-8 font-mono text-[12px]" />
                <Button type="button" variant="outline" size="sm" className="h-8"
                  onClick={() => setUUID(randomUUID())}>new</Button>
              </div>
            </div>
          )}

          <div>
            <Label className="text-[12px]" htmlFor="ind-alias">Alias</Label>
            <Input id="ind-alias" value={alias} onChange={(e) => setAlias(e.target.value)}
              placeholder="可选：节点别名，留空用默认命名"
              className="h-8 font-mono mt-1" />
          </div>

          {protocol === 'vless-reality' && (
            <>
              <div>
                <Label className="text-[12px]">REALITY SNI (target domain)</Label>
                <Input value={sni} onChange={(e) => setSNI(e.target.value)}
                  className="h-8 font-mono mt-1" />
                <p className="text-fg-dim text-[11px] mt-1">
                  Must be a single-tenant TLS endpoint. Do NOT use multi-tenant CDNs.
                </p>
              </div>
              <div>
                <Label className="text-[12px]">REALITY keypair</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={privateKey} placeholder="private" readOnly
                    className="h-8 font-mono text-[11px]" />
                  <Input value={publicKey} placeholder="public" readOnly
                    className="h-8 font-mono text-[11px]" />
                  <Button type="button" variant="outline" size="sm" className="h-8"
                    onClick={async () => {
                      const kp = await generateX25519()
                      setPrivateKey(kp.private_key); setPublicKey(kp.public_key)
                    }}>Generate</Button>
                </div>
              </div>
              <div>
                <Label className="text-[12px]">Short ID</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={shortID} onChange={(e) => setShortID(e.target.value)}
                    className="h-8 font-mono" />
                  <Button type="button" variant="outline" size="sm" className="h-8"
                    onClick={async () => {
                      const r = await generateShortID()
                      setShortID(r.short_id)
                    }}>Generate</Button>
                </div>
              </div>
            </>
          )}

          {protocol === 'vmess-ws' && (
            <div>
              <Label className="text-[12px]">WebSocket path</Label>
              <Input value={wsPath} onChange={(e) => setWSPath(e.target.value)}
                className="h-8 font-mono mt-1" />
            </div>
          )}

          {protocol === 'shadowsocks' && (
            <>
              <div>
                <Label className="text-[12px]" htmlFor="ind-ss-method">Method</Label>
                <select id="ind-ss-method"
                  aria-label="method"
                  value={ssMethod}
                  onChange={(e) => setSSMethod(e.target.value)}
                  className="mt-1 h-8 px-2 rounded-md border bg-background text-[13px] font-mono w-full disabled:opacity-60">
                  {XRAY_SS_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-[12px]">Password</Label>
                <div className="flex gap-2 mt-1">
                  <Input aria-label="ss password" value={ssPassword}
                    onChange={(e) => setSSPassword(e.target.value)}
                    className="h-8 font-mono text-[12px]" />
                  <Button type="button" variant="outline" size="sm" className="h-8"
                    onClick={() => setSSPassword(randomSSKey(ssMethod))}>new</Button>
                </div>
              </div>
            </>
          )}

          {error && <p className="text-err text-[12px]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button disabled={create.isPending || patch.isPending} onClick={submit}>
            {isEdit ? (patch.isPending ? 'Saving…' : 'Save') : (create.isPending ? 'Creating…' : 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
