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
  const { t } = useTranslation()
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
      toast('success', t('xray.inbound_dialog.created_toast', 'Inbound created'))
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
        ss_method: protocol === 'shadowsocks' && ssMethod !== editing.ss_method ? ssMethod : undefined,
        ss_password: protocol === 'shadowsocks' ? (ssPassword || undefined) : undefined,
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['xray-inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'xray'] })
      toast('success', t('xray.inbound_dialog.updated_toast', 'Inbound updated'))
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
            {isEdit ? t('xray.inbound_dialog.edit_title', 'Edit inbound {{tag}}', { tag: editing!.tag }) : t('xray.inbound_dialog.new_title', 'New inbound')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs" htmlFor="ind-server">{t('xray.inbound_dialog.server_label', 'Server')}</Label>
              <select id="ind-server"
                aria-label="server"
                value={serverID}
                onChange={(e) => setServerID(Number(e.target.value) || '')}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-sm font-mono w-full disabled:opacity-60">
                <option value="">{t('xray.inbound_dialog.select_placeholder', '— select —')}</option>
                {(serversQ.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <Label className="text-xs" htmlFor="ind-role">{t('xray.inbound_dialog.role_label', 'Role')}</Label>
              <select id="ind-role"
                aria-label="role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-sm font-mono w-full disabled:opacity-60">
                <option value="landing">{t('xray.inbound_dialog.role_landing', 'Landing')}</option>
                <option value="relay">{t('xray.inbound_dialog.role_relay', 'Relay')}</option>
              </select>
            </div>
          </div>

          {role === 'relay' && (
            <div>
              <Label className="text-xs" htmlFor="ind-upstream">{t('xray.inbound_dialog.upstream_label', 'Upstream landing-inbound')}</Label>
              <select id="ind-upstream"
                aria-label="upstream landing-inbound"
                value={upstreamID}
                onChange={(e) => setUpstreamID(Number(e.target.value) || '')}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-sm font-mono w-full disabled:opacity-60">
                <option value="">{t('xray.inbound_dialog.select_placeholder', '— select —')}</option>
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
              <Label className="text-xs">{t('xray.inbound_dialog.protocol_label', 'Protocol')}</Label>
              <select value={protocol}
                onChange={(e) => setProtocol(e.target.value as Protocol)}
                disabled={isEdit}
                className="mt-1 h-8 px-2 rounded-md border bg-background text-sm font-mono w-full disabled:opacity-60">
                <option value="vless-reality">VLESS + REALITY</option>
                <option value="vmess-ws">VMess + WS</option>
                <option value="shadowsocks">Shadowsocks</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">{t('xray.inbound_dialog.port_label', 'Port')}</Label>
              <Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))}
                className="h-8 font-mono mt-1" />
            </div>
          </div>

          {protocol !== 'shadowsocks' && (
            <div>
              <Label className="text-xs">{t('xray.inbound_dialog.uuid_label', 'UUID')}</Label>
              <div className="flex gap-2 mt-1">
                <Input value={uuid} onChange={(e) => setUUID(e.target.value)}
                  className="h-8 font-mono text-xs" />
                <Button type="button" variant="outline" size="sm"
                  onClick={() => setUUID(randomUUID())}>{t('xray.inbound_dialog.new_button', 'new')}</Button>
              </div>
            </div>
          )}

          <div>
            <Label className="text-xs" htmlFor="ind-alias">{t('xray.inbound_dialog.alias_label', 'Alias')}</Label>
            <Input id="ind-alias" value={alias} onChange={(e) => setAlias(e.target.value)}
              placeholder={t('xray.inbound_dialog.alias_placeholder', 'Optional — node alias, defaults to an auto-generated name if left blank')}
              className="h-8 font-mono mt-1" />
          </div>

          {protocol === 'vless-reality' && (
            <>
              <div>
                <Label className="text-xs">{t('xray.inbound_dialog.reality_sni_label', 'REALITY SNI (target domain)')}</Label>
                <Input value={sni} onChange={(e) => setSNI(e.target.value)}
                  className="h-8 font-mono mt-1" />
                <p className="text-fg-dim text-2xs mt-1">
                  {t('xray.inbound_dialog.reality_sni_hint', 'Must be a single-tenant TLS endpoint. Do NOT use multi-tenant CDNs.')}
                </p>
              </div>
              <div>
                <Label className="text-xs">{t('xray.inbound_dialog.reality_keypair_label', 'REALITY keypair')}</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={privateKey} placeholder={t('xray.inbound_dialog.reality_private_key_placeholder', 'private')} readOnly
                    className="h-8 font-mono text-2xs" />
                  <Input value={publicKey} placeholder={t('xray.inbound_dialog.reality_public_key_placeholder', 'public')} readOnly
                    className="h-8 font-mono text-2xs" />
                  <Button type="button" variant="outline" size="sm"
                    onClick={async () => {
                      const kp = await generateX25519()
                      setPrivateKey(kp.private_key); setPublicKey(kp.public_key)
                    }}>{t('xray.inbound_dialog.generate_button', 'Generate')}</Button>
                </div>
              </div>
              <div>
                <Label className="text-xs">{t('xray.inbound_dialog.short_id_label', 'Short ID')}</Label>
                <div className="flex gap-2 mt-1">
                  <Input value={shortID} onChange={(e) => setShortID(e.target.value)}
                    className="h-8 font-mono" />
                  <Button type="button" variant="outline" size="sm"
                    onClick={async () => {
                      const r = await generateShortID()
                      setShortID(r.short_id)
                    }}>{t('xray.inbound_dialog.generate_button', 'Generate')}</Button>
                </div>
              </div>
            </>
          )}

          {protocol === 'vmess-ws' && (
            <div>
              <Label className="text-xs">{t('xray.inbound_dialog.ws_path_label', 'WebSocket path')}</Label>
              <Input value={wsPath} onChange={(e) => setWSPath(e.target.value)}
                className="h-8 font-mono mt-1" />
            </div>
          )}

          {protocol === 'shadowsocks' && (
            <>
              <div>
                <Label className="text-xs" htmlFor="ind-ss-method">{t('xray.inbound_dialog.method_label', 'Method')}</Label>
                <select id="ind-ss-method"
                  aria-label="method"
                  value={ssMethod}
                  onChange={(e) => setSSMethod(e.target.value)}
                  className="mt-1 h-8 px-2 rounded-md border bg-background text-sm font-mono w-full disabled:opacity-60">
                  {XRAY_SS_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs">{t('xray.inbound_dialog.password_label', 'Password (base64)')}</Label>
                <div className="flex gap-2 mt-1">
                  <Input aria-label="ss password" value={ssPassword}
                    onChange={(e) => setSSPassword(e.target.value)}
                    className="h-8 font-mono text-xs" />
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => setSSPassword(randomSSKey(ssMethod))}>{t('xray.inbound_dialog.new_button', 'new')}</Button>
                </div>
              </div>
            </>
          )}

          {error && <p className="text-err text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>{t('common.cancel', 'Cancel')}</Button>
          <Button disabled={create.isPending || patch.isPending} onClick={submit}>
            {isEdit
              ? (patch.isPending ? t('xray.inbound_dialog.saving', 'Saving…') : t('xray.inbound_dialog.save_button', 'Save'))
              : (create.isPending ? t('xray.inbound_dialog.creating', 'Creating…') : t('common.create', 'Create'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
