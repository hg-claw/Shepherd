import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
  createMieruInbound, patchMieruInbound, type MieruInbound,
} from '@/api/plugins'
import { randomPort, randomPassword } from '../xray/templates'

type Proto = 'TCP' | 'UDP' | 'BOTH'

function randomUser(): string {
  return 'u' + Math.random().toString(16).slice(2, 10)
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: 'create' | 'edit'
  defaultServerID?: number
  inbound?: MieruInbound
}

export default function InboundDialog({ open, onOpenChange, mode, defaultServerID, inbound }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const serversQ = useServers()
  const editing = mode === 'edit' ? inbound : undefined

  const [serverID, setServerID] = useState<number | ''>(editing?.server_id ?? defaultServerID ?? '')
  const [port, setPort] = useState<number>(editing?.port ?? randomPort())
  const [alias, setAlias] = useState(editing?.alias ?? '')
  const [username, setUsername] = useState(editing?.username ?? randomUser())
  const [password, setPassword] = useState(editing ? '' : randomPassword())
  const [protocol, setProtocol] = useState<Proto>(editing?.protocol ?? 'TCP')
  const [mtu, setMTU] = useState(editing?.mtu ?? 1400)
  const [multiplexing, setMultiplexing] = useState(editing?.multiplexing ?? 'MULTIPLEXING_OFF')
  const [handshake, setHandshake] = useState(editing?.handshake_mode ?? 'HANDSHAKE_NO_WAIT')
  const [error, setError] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => createMieruInbound({
      server_id: Number(serverID), port, alias, username, password, protocol, mtu,
      multiplexing, handshake_mode: handshake,
    }),
    onSuccess: () => {
      toast('success', t('mieru.inbound.created', 'Inbound created'))
      qc.invalidateQueries({ queryKey: ['mieru-inbounds'] })
      onOpenChange(false)
    },
    onError: (e: Error) => setError(e.message),
  })
  const patch = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { port, alias, username, protocol, mtu, multiplexing, handshake_mode: handshake }
      if (password) body.password = password
      return patchMieruInbound(editing!.id, body)
    },
    onSuccess: () => {
      toast('success', t('mieru.inbound.saved', 'Inbound saved'))
      qc.invalidateQueries({ queryKey: ['mieru-inbounds'] })
      onOpenChange(false)
    },
    onError: (e: Error) => setError(e.message),
  })

  const labelCls = 'text-xs'
  const inputCls = 'h-8 text-sm'
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? t('mieru.inbound.edit', 'Edit inbound') : t('mieru.inbound.new', 'New inbound')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {mode === 'create' && (
            <div>
              <Label className={labelCls}>Server</Label>
              <select className="flex h-8 w-full rounded-md border bg-background px-2 text-sm" value={serverID}
                onChange={(e) => setServerID(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Select…</option>
                {(serversQ.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <Label className={labelCls}>Port</Label>
            <Input className={inputCls} type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </div>
          <div>
            <Label className={labelCls}>Protocol</Label>
            <select className="flex h-8 w-full rounded-md border bg-background px-2 text-sm" value={protocol}
              onChange={(e) => setProtocol(e.target.value as Proto)}>
              <option value="TCP">TCP</option>
              <option value="UDP">UDP</option>
              <option value="BOTH">BOTH (TCP + UDP at port+1)</option>
            </select>
          </div>
          <div>
            <Label className={labelCls} htmlFor="mieru-user">Username</Label>
            <Input id="mieru-user" className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div>
            <Label className={labelCls} htmlFor="mieru-pass">Password</Label>
            <div className="flex gap-1">
              <Input id="mieru-pass" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'edit' ? 'leave blank to keep' : ''} />
              <Button type="button" size="sm" variant="outline" onClick={() => setPassword(randomPassword())}>new</Button>
            </div>
          </div>
          <div>
            <Label className={labelCls}>Alias</Label>
            <Input className={inputCls} value={alias} onChange={(e) => setAlias(e.target.value)} />
          </div>
          <div>
            <Label className={labelCls}>MTU</Label>
            <Input className={inputCls} type="number" value={mtu} onChange={(e) => setMTU(Number(e.target.value))} />
          </div>
          <div>
            <Label className={labelCls}>Multiplexing (client)</Label>
            <select className="flex h-8 w-full rounded-md border bg-background px-2 text-sm" value={multiplexing}
              onChange={(e) => setMultiplexing(e.target.value)}>
              {['MULTIPLEXING_OFF', 'MULTIPLEXING_LOW', 'MULTIPLEXING_MIDDLE', 'MULTIPLEXING_HIGH'].map((v) =>
                <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
          <div>
            <Label className={labelCls}>Handshake (client)</Label>
            <select className="flex h-8 w-full rounded-md border bg-background px-2 text-sm" value={handshake}
              onChange={(e) => setHandshake(e.target.value)}>
              <option value="HANDSHAKE_NO_WAIT">HANDSHAKE_NO_WAIT</option>
              <option value="HANDSHAKE_STANDARD">HANDSHAKE_STANDARD</option>
            </select>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={create.isPending || patch.isPending || (mode === 'create' && !serverID)}
            onClick={() => mode === 'edit' ? patch.mutate() : create.mutate()}>
            {mode === 'edit' ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
