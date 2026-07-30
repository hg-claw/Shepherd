import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useUI } from '@/store/ui'
import {
  listSingboxCerts, listSingboxInbounds, createSingboxInbound, patchSingboxInbound,
  generateX25519, generateShortID, listPluginHosts,
  type SingboxInbound, type SingboxProtocol,
} from '@/api/plugins'
import { randomUUID, randomPort, randomPassword, randomSSKey } from '../xray/templates'
import { singboxMinorAtLeast } from './version'

// ─── Protocol list ───────────────────────────────────────────────────────────

const PROTOCOLS: { value: SingboxProtocol; label: string }[] = [
  { value: 'vless-reality',          label: 'VLESS + REALITY' },
  { value: 'vless-ws-tls',           label: 'VLESS + WS + TLS' },
  { value: 'vless-h2-tls',           label: 'VLESS + H2 + TLS' },
  { value: 'vless-httpupgrade-tls',  label: 'VLESS + HTTPUpgrade + TLS' },
  { value: 'vmess-tcp',              label: 'VMess + TCP' },
  { value: 'vmess-http',             label: 'VMess + HTTP' },
  { value: 'vmess-quic',             label: 'VMess + QUIC' },
  { value: 'vmess-ws-tls',           label: 'VMess + WS + TLS' },
  { value: 'vmess-h2-tls',           label: 'VMess + H2 + TLS' },
  { value: 'vmess-httpupgrade-tls',  label: 'VMess + HTTPUpgrade + TLS' },
  { value: 'trojan-tls',             label: 'Trojan + TLS' },
  { value: 'trojan-ws-tls',          label: 'Trojan + WS + TLS' },
  { value: 'trojan-h2-tls',          label: 'Trojan + H2 + TLS' },
  { value: 'trojan-httpupgrade-tls', label: 'Trojan + HTTPUpgrade + TLS' },
  { value: 'hysteria2',              label: 'Hysteria2' },
  { value: 'tuic-v5',               label: 'TUIC v5' },
  { value: 'anytls',                label: 'AnyTLS' },
  { value: 'shadowsocks-2022',       label: 'Shadowsocks 2022' },
  { value: 'snell-v5',               label: 'Snell v5' },
  { value: 'snell-v6',               label: 'Snell v6' },
]

const SS_METHODS = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
]

// obfs_mode ∈ none|http (v5), mode ∈ default|unshaped|unsafe-raw (v6) — must
// match the backend enums exactly (internal/plugins/singbox validation).
const SNELL_OBFS_MODES = ['none', 'http']
const SNELL_MODES = ['default', 'unshaped', 'unsafe-raw']

// ─── Per-protocol field predicates ───────────────────────────────────────────

function isSnell(p: SingboxProtocol): boolean {
  return p === 'snell-v5' || p === 'snell-v6'
}
function needsUUID(p: SingboxProtocol): boolean {
  return p.startsWith('vless-') || p.startsWith('vmess-') || p === 'tuic-v5'
}
function needsPassword(p: SingboxProtocol): boolean {
  // Snell's psk rides in the same `password` field/column as the other
  // protocols — no separate psk column on the backend.
  return p.startsWith('trojan-') || p === 'hysteria2' || p === 'tuic-v5' || p === 'anytls' || isSnell(p)
}
function needsSS(p: SingboxProtocol): boolean {
  return p === 'shadowsocks-2022'
}
function needsReality(p: SingboxProtocol): boolean {
  return p === 'vless-reality'
}
function needsCertAndSNI(p: SingboxProtocol): boolean {
  // All TLS protocols that use a cert (not reality, not vmess-tcp/http, not ss2022)
  if (needsReality(p) || needsSS(p)) return false
  return (
    p.endsWith('-tls') ||
    p === 'vmess-quic' ||
    p === 'hysteria2' ||
    p === 'tuic-v5' ||
    p === 'anytls'
  )
}
function needsTransport(p: SingboxProtocol): boolean {
  return (
    p.includes('-ws-') ||
    p.includes('-h2-') ||
    p.includes('-httpupgrade-') ||
    p === 'vmess-http'
  )
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  serverID: number
  /** If provided, dialog is in edit mode */
  initial?: SingboxInbound
  open: boolean
  onClose: () => void
  onSaved: () => void
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function InboundDialog({ serverID, initial, open, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const isEdit = !!initial
  // Snell's obfs_mode (v5) / mode (v6) ride in the generic `extra` JSON
  // field — parse whatever the backend returned so editing an existing
  // snell inbound pre-fills the right dropdown option.
  const initialExtra: Record<string, unknown> = (() => {
    try { return initial?.extra_json ? JSON.parse(initial.extra_json) : {} }
    catch { return {} }
  })()
  // Relays have a different shape from landings: they're created by
  // BulkRelayDialog and store the relay-side keys, NOT the landing-side
  // handshake server / private key (those are landing-only concepts in
  // our model — see render.go renderVlessReality). Treating a relay
  // like a landing during edit overwrote the relay's NULL columns with
  // dialog defaults ('', '443'), which the renderer then emitted into
  // the config and broke the relay. Detect role and adapt: hide the
  // landing-only fields and skip them in the patch body.
  const isRelayEdit = isEdit && initial!.role === 'relay'

  // ── Certs ──
  const { data: certs = [] } = useQuery({
    queryKey: ['singbox', 'certs'],
    queryFn:  listSingboxCerts,
  })
  const validCerts = certs.filter((c) => c.status === 'active')

  // ── Inbounds (for the relay upstream picker) ──
  // Same key as InboundsTab's list — react-query serves this from cache
  // instead of refetching. Only needed while creating a relay.
  const { data: allInbounds = [] } = useQuery({
    queryKey: ['singbox', 'inbounds'],
    queryFn: () => listSingboxInbounds(),
  })
  const landings = allInbounds.filter((i) => i.role === 'landing')

  // ── Form state ──
  const [protocol, setProtocol] = useState<SingboxProtocol>(initial?.protocol ?? 'vless-reality')
  const [port, setPort]         = useState<string>(String(initial?.port ?? randomPort()))
  const [alias, setAlias]       = useState<string>(initial?.alias ?? '')

  // UUID
  const [uuid, setUUID] = useState<string>(initial?.uuid ?? randomUUID())

  // Password (trojan / hysteria2 / tuic / anytls)
  const [password, setPassword] = useState<string>(initial?.password ?? '')

  // Cert + SNI (TLS protocols)
  const [certID, setCertID] = useState<string>(initial?.cert_id != null ? String(initial.cert_id) : '')
  const [sni, setSNI]       = useState<string>(initial?.sni ?? '')

  // Transport path + host (ws / h2 / httpupgrade / vmess-http)
  const [transportPath, setTransportPath] = useState<string>(initial?.transport_path ?? '/proxy')
  const [transportHost, setTransportHost] = useState<string>(initial?.transport_host ?? '')

  // REALITY fields
  const [privKey,  setPrivKey]  = useState<string>('')  // never pre-filled (redacted)
  const [pubKey,   setPubKey]   = useState<string>(initial?.reality_public_key ?? '')
  const [shortID,  setShortID]  = useState<string>(initial?.reality_short_id ?? '')
  const [hsServer, setHSServer] = useState<string>(initial?.reality_handshake_server ?? '')
  const [hsPort,   setHSPort]   = useState<string>(String(initial?.reality_handshake_port ?? '443'))

  // Shadowsocks 2022
  const [ssMethod,   setSSMethod]   = useState<string>(initial?.ss_method ?? SS_METHODS[0])
  const [ssPassword, setSSPassword] = useState<string>(initial?.ss_password ?? '')

  // Snell (psk shares the `password` state above)
  const [snellObfs, setSnellObfs] = useState<string>(
    typeof initialExtra.obfs_mode === 'string' ? initialExtra.obfs_mode : SNELL_OBFS_MODES[0],
  )
  const [snellMode, setSnellMode] = useState<string>(
    typeof initialExtra.mode === 'string' ? initialExtra.mode : SNELL_MODES[0],
  )

  // Relay wiring. These three are create-only: the backend's InboundPatch
  // carries no role / relay_mode / protocol / upstream_inbound_id, so the
  // patch path neither reads nor writes them.
  const [role, setRole]             = useState<'landing' | 'relay'>('landing')
  const [upstreamID, setUpstreamID] = useState<string>('')
  const [relayMode, setRelayMode]   = useState<'forward' | 'proxy'>('forward')

  const selectedLanding = landings.find((l) => String(l.id) === upstreamID)

  // Forward relays render as a sing-box "direct" inbound — the protocol
  // switch is short-circuited server-side, so every protocol field is
  // dead weight. Collapse them and inherit the landing's protocol.
  const isForward = role === 'relay' && relayMode === 'forward'

  // ── Snell / sing-box 1.14 version warning ──
  // Same query key as InboundsTab uses — served from cache, no second
  // request. Rows carry deployed_version, which is free-form and often
  // null on hosts installed before the version column was populated.
  const { data: hosts = [] } = useQuery({
    queryKey: ['plugin-hosts', 'singbox'],
    queryFn: () => listPluginHosts('singbox'),
  })
  const hostVersion = hosts.find((h) => h.server_id === serverID)?.deployed_version ?? null
  const isSnellProtocol = protocol === 'snell-v5' || protocol === 'snell-v6'
  // Backend refuses the create with 409 anyway (inboundNeeds114); this is
  // just so it isn't a surprise. Not a disable — the host's version can
  // change while the dialog is open. Forward relays are exempt: they
  // render as `direct` and never run snell (see isForward above).
  const snellNeedsUpgrade = !isForward && isSnellProtocol && !singboxMinorAtLeast(hostVersion, 1, 14)

  const [error, setError] = useState<string | null>(null)

  // Reset cert when switching protocols (cert may no longer apply)
  useEffect(() => { setCertID('') }, [protocol])

  // ── Save mutation ──
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        server_id: serverID,
        port:      Number(port),
        // Forward relays skip the protocol picker entirely, so they have
        // no protocol of their own — inherit the landing's. subgen's
        // forward special-case and the inbound list's protocol column
        // both read this field, so it must not be blank.
        protocol:  isForward && selectedLanding ? selectedLanding.protocol : protocol,
      }

      body.alias = alias

      if (!isForward) {
        if (needsUUID(protocol))       body.uuid = uuid
        if (needsPassword(protocol))   body.password = password
        if (needsCertAndSNI(protocol)) { body.sni = sni; body.cert_id = certID ? Number(certID) : undefined }
        if (needsTransport(protocol))  { body.transport_path = transportPath; body.transport_host = transportHost }
        if (needsReality(protocol))    {
          body.sni = sni
          // Omit private_key on PATCH when the input is empty — that
          // means the admin didn't touch the field. The field starts
          // empty because the GET response redacts the secret;
          // sending an empty string would otherwise overwrite the
          // stored key with "" and break the REALITY handshake.
          if (!isEdit || privKey !== '') {
            body.reality_private_key = privKey
          }
          body.reality_public_key        = pubKey
          body.reality_short_id          = shortID
          // Skip the landing-only handshake fields when editing a relay
          // — relays don't have these in our schema and overwriting
          // with the dialog's empty defaults corrupts the row.
          if (!isRelayEdit) {
            body.reality_handshake_server  = hsServer
            body.reality_handshake_port    = Number(hsPort)
          }
        }
        if (needsSS(protocol)) {
          body.ss_method   = ssMethod
          body.ss_password = ssPassword
        }
        // obfs_mode (v5) / mode (v6) travel in the generic `extra` JSON field
        // — the same channel hysteria2's up_mbps uses server-side. `extra`
        // is a whole-column overwrite server-side, so merge into whatever
        // the row already carried instead of replacing it: this dialog only
        // knows two keys, and an API client is free to have put others there.
        if (protocol === 'snell-v5') body.extra = JSON.stringify({ ...initialExtra, obfs_mode: snellObfs })
        if (protocol === 'snell-v6') body.extra = JSON.stringify({ ...initialExtra, mode: snellMode })
      }

      if (isEdit) {
        // Only send patchable fields
        const { server_id: _sid, protocol: _proto, ...patch } = body
        void _sid; void _proto
        return patchSingboxInbound(initial!.id, patch as never)
      }
      if (role === 'relay') {
        body.role = 'relay'
        body.relay_mode = relayMode
        body.upstream_inbound_id = Number(upstreamID)
      } else {
        body.role = 'landing'
      }
      return createSingboxInbound(body as never)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['singbox', 'inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
      toast('success', isEdit ? t('singbox.inbound_dialog.updated_toast', 'Inbound updated') : t('singbox.inbound_dialog.created_toast', 'Inbound created'))
      onSaved()
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
    },
  })

  // ── Keypair generator ──
  async function genKeypair() {
    try {
      const kp = await generateX25519()
      setPrivKey(kp.private_key)
      setPubKey(kp.public_key)
    } catch (e) {
      toast('error', String((e as Error)?.message ?? e))
    }
  }

  async function genShortID() {
    try {
      const r = await generateShortID()
      setShortID(r.short_id)
    } catch (e) {
      toast('error', String((e as Error)?.message ?? e))
    }
  }

  function handleSave() {
    setError(null)
    if (!isEdit && role === 'relay' && !upstreamID) {
      setError(t('singbox.inbound_dialog.upstream_required', 'Select an upstream landing'))
      return
    }
    save.mutate()
  }

  // ─────────────────────────────────────────────────────────────────────────

  const inputCls = 'h-8 font-mono text-sm mt-0.5'
  const labelCls = 'text-2xs text-muted-foreground mb-0.5 block'
  const selectCls = 'h-8 px-2 rounded-md border bg-background text-sm font-mono w-full disabled:opacity-60'

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {isEdit ? t('singbox.inbound_dialog.edit_title', 'Edit — {{tag}}', { tag: initial!.tag }) : t('singbox.inbound_dialog.new_title', 'New inbound')}
            {isRelayEdit && (
              <span className="ml-2 text-2xs uppercase tracking-[0.05em] text-warn font-sans align-middle">
                {t('singbox.inbound_dialog.relay_limited_badge', 'relay · limited')}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {isRelayEdit && (
            <div className="rounded border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-2xs text-warn">
              {t('singbox.inbound_dialog.relay_edit_notice', 'Editing a relay. Its REALITY handshake target was copied from the upstream landing when the relay was created and is stored on this row — changing the landing does not propagate here.')}
            </div>
          )}

          {/* ── Role / upstream / relay mode — create-only. The backend's
              InboundPatch carries none of these, so editing never shows
              them (see isRelayEdit above for the edit-mode relay view). ── */}
          {!isEdit && (
            <>
              <div>
                <Label className={labelCls} htmlFor="ib-role">{t('singbox.inbound_dialog.role', 'Role')}</Label>
                <select id="ib-role"
                  className={selectCls}
                  value={role}
                  onChange={(e) => setRole(e.target.value as 'landing' | 'relay')}>
                  <option value="landing">{t('singbox.inbound_dialog.role_landing', 'Landing')}</option>
                  <option value="relay">{t('singbox.inbound_dialog.role_relay', 'Relay')}</option>
                </select>
              </div>
              {role === 'relay' && (
                <>
                  <div>
                    <Label className={labelCls} htmlFor="ib-upstream">{t('singbox.inbound_dialog.upstream', 'Upstream landing')}</Label>
                    <select id="ib-upstream"
                      className={selectCls}
                      value={upstreamID}
                      onChange={(e) => setUpstreamID(e.target.value)}>
                      <option value="">{t('singbox.inbound_dialog.upstream_placeholder', 'Select a landing…')}</option>
                      {landings.map((l) => (
                        <option key={l.id} value={String(l.id)}>
                          {l.server_name} / {l.tag} / {l.protocol}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <Label className={labelCls}>{t('singbox.inbound_dialog.relay_mode', 'Relay mode')}</Label>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant={relayMode === 'forward' ? 'default' : 'outline'}
                        onClick={() => setRelayMode('forward')}
                      >
                        {t('singbox.inbound_dialog.mode_forward', 'Forward')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant={relayMode === 'proxy' ? 'default' : 'outline'}
                        onClick={() => setRelayMode('proxy')}
                      >
                        {t('singbox.inbound_dialog.mode_proxy', 'Proxy')}
                      </Button>
                    </div>
                    <p className="text-2xs text-muted-foreground mt-0.5">
                      {relayMode === 'forward'
                        ? t('singbox.inbound_dialog.mode_forward_desc', 'Transparently forwards raw bytes to the landing. Clients speak the landing\'s protocol; this relay needs no credentials.')
                        : t('singbox.inbound_dialog.mode_proxy_desc', 'This relay terminates its own protocol with its own credentials, then dials the landing. Pick any protocol below — it does not have to match the landing.')}
                    </p>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Port + Protocol ── Protocol is omitted for forward relays:
              they inherit the landing's protocol (see isForward below). */}
          <div className={isForward ? '' : 'grid grid-cols-2 gap-3'}>
            <div>
              <Label className={labelCls} htmlFor="ib-port">{t('singbox.inbound_dialog.port_label', 'Port')}</Label>
              <Input id="ib-port" className={inputCls} value={port}
                onChange={(e) => setPort(e.target.value)} placeholder="443" />
            </div>
            {!isForward && (
              <div>
                <Label className={labelCls} htmlFor="ib-proto">{t('singbox.inbound_dialog.protocol_label', 'Protocol')}</Label>
                <select id="ib-proto"
                  className={selectCls}
                  value={protocol}
                  disabled={isEdit}
                  onChange={(e) => { setProtocol(e.target.value as SingboxProtocol); setError(null) }}>
                  {PROTOCOLS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {snellNeedsUpgrade && (
            <p className="text-xs text-warn">
              {t('singbox.inbound_dialog.snell_needs_114', 'Snell requires sing-box 1.14+ on this host — upgrade it on the Deploy tab first.')}
            </p>
          )}

          {/* ── Alias (optional) ── */}
          <div>
            <Label className={labelCls} htmlFor="ib-alias">{t('singbox.inbound_dialog.alias_label', 'Alias (optional)')}</Label>
            <Input id="ib-alias" className={inputCls}
              value={alias} onChange={(e) => setAlias(e.target.value)}
              placeholder={t('singbox.inbound_dialog.alias_placeholder', 'Optional — node alias, defaults to an auto-generated name if left blank')} />
          </div>

          {!isForward && (
            <>
            {/* ── UUID (vless / vmess / tuic) ── */}
            {needsUUID(protocol) && (
              <div>
                <Label className={labelCls} htmlFor="ib-uuid">{t('singbox.inbound_dialog.uuid_label', 'UUID')}</Label>
                <div className="flex gap-2">
                  <Input id="ib-uuid" className={inputCls + ' flex-1'}
                    value={uuid} onChange={(e) => setUUID(e.target.value)} />
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => setUUID(randomUUID())}>{t('singbox.inbound_dialog.new_button', 'new')}</Button>
                </div>
              </div>
            )}

            {/* ── Password (trojan / hysteria2 / tuic / anytls / snell psk) ── */}
            {needsPassword(protocol) && (
              <div>
                <Label className={labelCls} htmlFor="ib-pw">
                  {isSnell(protocol)
                    ? t('singbox.snell.psk', 'PSK')
                    : t('singbox.inbound_dialog.password_label', 'Password')}
                </Label>
                <div className="flex gap-2">
                  <Input id="ib-pw" className={inputCls + ' flex-1'}
                    value={password} onChange={(e) => setPassword(e.target.value)} />
                  <Button type="button" variant="outline" size="sm"
                    onClick={() => setPassword(randomPassword())}>{t('singbox.inbound_dialog.new_button', 'new')}</Button>
                </div>
              </div>
            )}

            {/* ── Snell obfs_mode (v5) / mode (v6) ── */}
            {protocol === 'snell-v5' && (
              <div>
                <Label className={labelCls} htmlFor="ib-snell-obfs">{t('singbox.snell.obfs_mode', 'Obfuscation')}</Label>
                <select id="ib-snell-obfs"
                  className={selectCls}
                  value={snellObfs}
                  onChange={(e) => setSnellObfs(e.target.value)}>
                  {SNELL_OBFS_MODES.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}
            {protocol === 'snell-v6' && (
              <div>
                <Label className={labelCls} htmlFor="ib-snell-mode">{t('singbox.snell.mode', 'Traffic mode')}</Label>
                <select id="ib-snell-mode"
                  className={selectCls}
                  value={snellMode}
                  onChange={(e) => setSnellMode(e.target.value)}>
                  {SNELL_MODES.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}

            {/* ── REALITY fields ── */}
            {needsReality(protocol) && (
              <>
                <div>
                  <Label className={labelCls} htmlFor="ib-sni-reality">{t('singbox.inbound_dialog.reality_sni_label', 'SNI (REALITY target domain)')}</Label>
                  <Input id="ib-sni-reality" className={inputCls}
                    value={sni} onChange={(e) => setSNI(e.target.value)}
                    placeholder="www.icloud.com" />
                  <p className="text-2xs text-muted-foreground mt-0.5">
                    {t('singbox.inbound_dialog.reality_sni_hint', 'Must be a single-tenant TLS endpoint — not a multi-tenant CDN.')}
                  </p>
                </div>

                {/* Keypair */}
                <div>
                  <Label className={labelCls}>{t('singbox.inbound_dialog.reality_keypair_label', 'REALITY keypair (Curve25519)')}</Label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Label htmlFor="ib-privkey" className="sr-only">{t('singbox.inbound_dialog.reality_private_key_placeholder', 'private key')}</Label>
                      <Input id="ib-privkey" placeholder={t('singbox.inbound_dialog.reality_private_key_placeholder', 'private key')} readOnly
                        className={inputCls + ' w-full text-2xs'} value={privKey} />
                    </div>
                    <div className="flex-1">
                      <Label htmlFor="ib-pubkey" className="sr-only">{t('singbox.inbound_dialog.reality_public_key_placeholder', 'public key')}</Label>
                      <Input id="ib-pubkey" placeholder={t('singbox.inbound_dialog.reality_public_key_placeholder', 'public key')} readOnly
                        className={inputCls + ' w-full text-2xs'} value={pubKey} />
                    </div>
                    <Button type="button" variant="outline" size="sm"
                      onClick={genKeypair}>{t('singbox.inbound_dialog.generate_button', 'Generate')}</Button>
                  </div>
                  <p className="text-2xs text-muted-foreground mt-0.5">
                    {t('singbox.inbound_dialog.reality_keypair_hint', 'Uses the same Curve25519 endpoint as Xray (shared crypto).')}
                  </p>
                </div>

                {/* Short ID + Handshake host (handshake hidden for relays —
                    not part of their schema). */}
                <div className={isRelayEdit ? '' : 'grid grid-cols-2 gap-3'}>
                  <div>
                    <Label className={labelCls} htmlFor="ib-sid">{t('singbox.inbound_dialog.short_id_label', 'Short ID')}</Label>
                    <div className="flex gap-2">
                      <Input id="ib-sid" className={inputCls + ' flex-1 font-mono'}
                        value={shortID} onChange={(e) => setShortID(e.target.value)} />
                      <Button type="button" variant="outline" size="sm"
                        onClick={genShortID}>{t('singbox.inbound_dialog.gen_button', 'Gen')}</Button>
                    </div>
                  </div>
                  {!isRelayEdit && (
                    <div>
                      <Label className={labelCls} htmlFor="ib-hs">{t('singbox.inbound_dialog.handshake_host_label', 'Handshake host')}</Label>
                      <Input id="ib-hs" className={inputCls}
                        value={hsServer} onChange={(e) => setHSServer(e.target.value)}
                        placeholder="www.apple.com" />
                    </div>
                  )}
                </div>

                {!isRelayEdit && (
                  <div>
                    <Label className={labelCls} htmlFor="ib-hp">{t('singbox.inbound_dialog.handshake_port_label', 'Handshake port')}</Label>
                    <Input id="ib-hp" className={inputCls + ' w-28'}
                      value={hsPort} onChange={(e) => setHSPort(e.target.value)}
                      placeholder="443" />
                  </div>
                )}
              </>
            )}

            {/* ── Cert + SNI (TLS protocols, non-reality) ── */}
            {needsCertAndSNI(protocol) && (
              <>
                <div>
                  <Label className={labelCls} htmlFor="ib-sni-tls">{t('singbox.inbound_dialog.tls_sni_label', 'SNI / Domain')}</Label>
                  <Input id="ib-sni-tls" className={inputCls}
                    value={sni} onChange={(e) => setSNI(e.target.value)}
                    placeholder="proxy.example.com" />
                </div>
                <div>
                  <Label className={labelCls} htmlFor="ib-cert">{t('singbox.inbound_dialog.cert_label', 'Certificate')}</Label>
                  {validCerts.length === 0 ? (
                    <p className="text-2xs text-muted-foreground">
                      {t('singbox.inbound_dialog.cert_none', 'No valid certificates. Issue one in the Certificates tab first.')}
                    </p>
                  ) : (
                    <select id="ib-cert"
                      className={selectCls}
                      value={certID}
                      onChange={(e) => setCertID(e.target.value)}>
                      <option value="">{t('singbox.inbound_dialog.cert_select_placeholder', '— select certificate —')}</option>
                      {validCerts.map((c) => (
                        <option key={c.id} value={String(c.id)}>
                          {c.domain}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </>
            )}

            {/* ── Transport path + host (ws / h2 / httpupgrade / vmess-http) ── */}
            {needsTransport(protocol) && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className={labelCls} htmlFor="ib-path">{t('singbox.inbound_dialog.path_label', 'Path')}</Label>
                  <Input id="ib-path" className={inputCls}
                    value={transportPath} onChange={(e) => setTransportPath(e.target.value)}
                    placeholder="/proxy" />
                </div>
                <div>
                  <Label className={labelCls} htmlFor="ib-host">{t('singbox.inbound_dialog.host_header_label', 'Host header')}</Label>
                  <Input id="ib-host" className={inputCls}
                    value={transportHost} onChange={(e) => setTransportHost(e.target.value)} />
                </div>
              </div>
            )}

            {/* ── Shadowsocks 2022 ── */}
            {needsSS(protocol) && (
              <>
                <div>
                  <Label className={labelCls} htmlFor="ib-ssm">{t('singbox.inbound_dialog.method_label', 'Method')}</Label>
                  <select id="ib-ssm"
                    className={selectCls}
                    value={ssMethod}
                    onChange={(e) => setSSMethod(e.target.value)}>
                    {SS_METHODS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className={labelCls} htmlFor="ib-sspw">{t('singbox.inbound_dialog.ss_password_label', 'Password (base64)')}</Label>
                  <div className="flex gap-2">
                    <Input id="ib-sspw" className={inputCls + ' flex-1'}
                      value={ssPassword} onChange={(e) => setSSPassword(e.target.value)} />
                    <Button type="button" variant="outline" size="sm"
                      onClick={() => setSSPassword(randomSSKey(ssMethod))}>{t('singbox.inbound_dialog.new_button', 'new')}</Button>
                  </div>
                </div>
              </>
            )}
            </>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('common.cancel', 'Cancel')}</Button>
          <Button disabled={save.isPending} onClick={handleSave}>
            {save.isPending
              ? (isEdit ? t('singbox.inbound_dialog.saving', 'Saving…') : t('singbox.inbound_dialog.creating', 'Creating…'))
              : (isEdit ? t('singbox.inbound_dialog.save_button', 'Save') : t('common.create', 'Create'))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
