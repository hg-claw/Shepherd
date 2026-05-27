import { useState, useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { useUI } from '@/store/ui'
import {
  listSingboxCerts, createSingboxInbound, patchSingboxInbound,
  generateX25519, generateShortID,
  type SingboxInbound, type SingboxProtocol,
} from '@/api/plugins'
import { randomUUID, randomPort, randomPassword, randomSSKey } from '../xray/templates'

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
]

const SS_METHODS = [
  '2022-blake3-aes-128-gcm',
  '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305',
]

// ─── Per-protocol field predicates ───────────────────────────────────────────

function needsUUID(p: SingboxProtocol): boolean {
  return p.startsWith('vless-') || p.startsWith('vmess-') || p === 'tuic-v5'
}
function needsPassword(p: SingboxProtocol): boolean {
  return p.startsWith('trojan-') || p === 'hysteria2' || p === 'tuic-v5' || p === 'anytls'
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
  const qc = useQueryClient()
  const toast = useUI((s) => s.toast)
  const isEdit = !!initial
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

  const [error, setError] = useState<string | null>(null)

  // Reset cert when switching protocols (cert may no longer apply)
  useEffect(() => { setCertID('') }, [protocol])

  // ── Save mutation ──
  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        server_id: serverID,
        port:      Number(port),
        protocol,
      }

      body.alias = alias

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

      if (isEdit) {
        // Only send patchable fields
        const { server_id: _sid, protocol: _proto, ...patch } = body
        void _sid; void _proto
        return patchSingboxInbound(initial!.id, patch as never)
      }
      body.role = 'landing'
      return createSingboxInbound(body as never)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['singbox', 'inbounds'] })
      qc.invalidateQueries({ queryKey: ['plugin-hosts', 'singbox'] })
      toast('success', isEdit ? 'Inbound updated' : 'Inbound created')
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

  // ─────────────────────────────────────────────────────────────────────────

  const inputCls = 'h-8 font-mono text-[12.5px] mt-0.5'
  const labelCls = 'text-[11.5px] text-muted-foreground mb-0.5 block'
  const selectCls = 'h-8 px-2 rounded-md border bg-background text-[12.5px] font-mono w-full disabled:opacity-60'

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {isEdit ? `Edit — ${initial!.tag}` : 'New inbound'}
            {isRelayEdit && (
              <span className="ml-2 text-[10px] uppercase tracking-wider text-warn font-sans align-middle">
                relay · limited
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {isRelayEdit && (
            <div className="rounded border border-warn/50 bg-warn/10 px-2.5 py-1.5 text-[11.5px] text-warn">
              Editing a relay. Handshake server / port are inherited from the upstream landing
              and not editable here — change them on the landing inbound to propagate.
            </div>
          )}
          {/* ── Port + Protocol ── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className={labelCls} htmlFor="ib-port">Port</Label>
              <Input id="ib-port" className={inputCls} value={port}
                onChange={(e) => setPort(e.target.value)} placeholder="443" />
            </div>
            <div>
              <Label className={labelCls} htmlFor="ib-proto">Protocol</Label>
              <select id="ib-proto" aria-label="protocol"
                className={selectCls}
                value={protocol}
                disabled={isEdit}
                onChange={(e) => { setProtocol(e.target.value as SingboxProtocol); setError(null) }}>
                {PROTOCOLS.map(({ value, label }) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* ── Alias (optional) ── */}
          <div>
            <Label className={labelCls} htmlFor="ib-alias">Alias (optional)</Label>
            <Input id="ib-alias" className={inputCls}
              value={alias} onChange={(e) => setAlias(e.target.value)}
              placeholder="可选：节点别名，留空用默认命名" />
          </div>

          {/* ── UUID (vless / vmess / tuic) ── */}
          {needsUUID(protocol) && (
            <div>
              <Label className={labelCls} htmlFor="ib-uuid">UUID</Label>
              <div className="flex gap-2">
                <Input id="ib-uuid" aria-label="uuid" className={inputCls + ' flex-1'}
                  value={uuid} onChange={(e) => setUUID(e.target.value)} />
                <Button type="button" variant="outline" size="sm" className="h-8"
                  onClick={() => setUUID(randomUUID())}>new</Button>
              </div>
            </div>
          )}

          {/* ── Password (trojan / hysteria2 / tuic / anytls) ── */}
          {needsPassword(protocol) && (
            <div>
              <Label className={labelCls} htmlFor="ib-pw">Password</Label>
              <div className="flex gap-2">
                <Input id="ib-pw" aria-label="password" className={inputCls + ' flex-1'}
                  value={password} onChange={(e) => setPassword(e.target.value)} />
                <Button type="button" variant="outline" size="sm" className="h-8"
                  onClick={() => setPassword(randomPassword())}>new</Button>
              </div>
            </div>
          )}

          {/* ── REALITY fields ── */}
          {needsReality(protocol) && (
            <>
              <div>
                <Label className={labelCls} htmlFor="ib-sni-reality">SNI (REALITY target domain)</Label>
                <Input id="ib-sni-reality" aria-label="sni" className={inputCls}
                  value={sni} onChange={(e) => setSNI(e.target.value)}
                  placeholder="www.icloud.com" />
                <p className="text-[10.5px] text-muted-foreground mt-0.5">
                  Must be a single-tenant TLS endpoint — not a multi-tenant CDN.
                </p>
              </div>

              {/* Keypair */}
              <div>
                <Label className={labelCls}>REALITY keypair (Curve25519)</Label>
                <div className="flex gap-2">
                  <Input aria-label="private key" placeholder="private key" readOnly
                    className={inputCls + ' flex-1 text-[11px]'} value={privKey} />
                  <Input aria-label="public key" placeholder="public key" readOnly
                    className={inputCls + ' flex-1 text-[11px]'} value={pubKey} />
                  <Button type="button" variant="outline" size="sm" className="h-8"
                    onClick={genKeypair}>Generate</Button>
                </div>
                <p className="text-[10.5px] text-muted-foreground mt-0.5">
                  Uses the same Curve25519 endpoint as Xray (shared crypto).
                </p>
              </div>

              {/* Short ID + Handshake host (handshake hidden for relays —
                  not part of their schema). */}
              <div className={isRelayEdit ? '' : 'grid grid-cols-2 gap-3'}>
                <div>
                  <Label className={labelCls} htmlFor="ib-sid">Short ID</Label>
                  <div className="flex gap-2">
                    <Input id="ib-sid" aria-label="short id" className={inputCls + ' flex-1 font-mono'}
                      value={shortID} onChange={(e) => setShortID(e.target.value)} />
                    <Button type="button" variant="outline" size="sm" className="h-8"
                      onClick={genShortID}>Gen</Button>
                  </div>
                </div>
                {!isRelayEdit && (
                  <div>
                    <Label className={labelCls} htmlFor="ib-hs">Handshake host</Label>
                    <Input id="ib-hs" className={inputCls}
                      value={hsServer} onChange={(e) => setHSServer(e.target.value)}
                      placeholder="www.apple.com" />
                  </div>
                )}
              </div>

              {!isRelayEdit && (
                <div>
                  <Label className={labelCls} htmlFor="ib-hp">Handshake port</Label>
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
                <Label className={labelCls} htmlFor="ib-sni-tls">SNI / Domain</Label>
                <Input id="ib-sni-tls" aria-label="sni" className={inputCls}
                  value={sni} onChange={(e) => setSNI(e.target.value)}
                  placeholder="proxy.example.com" />
              </div>
              <div>
                <Label className={labelCls} htmlFor="ib-cert">Certificate</Label>
                {validCerts.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">
                    No valid certificates. Issue one in the Certificates tab first.
                  </p>
                ) : (
                  <select id="ib-cert" aria-label="certificate"
                    className={selectCls}
                    value={certID}
                    onChange={(e) => setCertID(e.target.value)}>
                    <option value="">— select certificate —</option>
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
                <Label className={labelCls} htmlFor="ib-path">Path</Label>
                <Input id="ib-path" className={inputCls}
                  value={transportPath} onChange={(e) => setTransportPath(e.target.value)}
                  placeholder="/proxy" />
              </div>
              <div>
                <Label className={labelCls} htmlFor="ib-host">Host header</Label>
                <Input id="ib-host" className={inputCls}
                  value={transportHost} onChange={(e) => setTransportHost(e.target.value)} />
              </div>
            </div>
          )}

          {/* ── Shadowsocks 2022 ── */}
          {needsSS(protocol) && (
            <>
              <div>
                <Label className={labelCls} htmlFor="ib-ssm">Method</Label>
                <select id="ib-ssm" aria-label="method"
                  className={selectCls}
                  value={ssMethod}
                  onChange={(e) => setSSMethod(e.target.value)}>
                  {SS_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className={labelCls} htmlFor="ib-sspw">Password (base64)</Label>
                <div className="flex gap-2">
                  <Input id="ib-sspw" aria-label="ss password" className={inputCls + ' flex-1'}
                    value={ssPassword} onChange={(e) => setSSPassword(e.target.value)} />
                  <Button type="button" variant="outline" size="sm" className="h-8"
                    onClick={() => setSSPassword(randomSSKey(ssMethod))}>new</Button>
                </div>
              </div>
            </>
          )}

          {error && <p className="text-[12px] text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending
              ? (isEdit ? 'Saving…' : 'Creating…')
              : (isEdit ? 'Save' : 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
