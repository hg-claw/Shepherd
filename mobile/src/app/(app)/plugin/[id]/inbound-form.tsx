import { useMemo, useState } from 'react'
import { View, Text, ScrollView, Pressable, KeyboardAvoidingView, Platform } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  useInbounds, createInbound, patchInbound, invalidateInbounds,
  generateX25519, generateShortID, randomUUID, randomPort, randomPassword, randomSSKey,
  needsUUID, needsPassword, needsSS, needsReality, needsCertAndSNI, needsTransport,
  singboxCreatableOnMobile,
  SINGBOX_PROTOCOLS, SINGBOX_SS_METHODS, XRAY_PROTOCOLS, XRAY_SS_METHODS,
  type ProxyPluginID, type ProxyInboundFull,
} from '@/api/inbounds'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, Field, Input, Hint, ErrLine, Button, Empty } from '@/components/ds'

function isInboundsPlugin(id?: string): id is ProxyPluginID {
  return id === 'singbox' || id === 'xray'
}

// xray protocol → its conditional groups (it has its own 3-protocol scheme,
// distinct from sing-box's predicates).
function xrayNeedsReality(p: string): boolean { return p === 'vless-reality' }
function xrayNeedsWS(p: string): boolean { return p === 'vmess-ws' }
function xrayNeedsSS(p: string): boolean { return p === 'shadowsocks' }

// ── inline option list (no native <select>; Pressable rows like the host chips) ──

function OptionList<T extends string>({
  value, options, onChange, disabled, testID,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  disabled?: boolean
  testID?: string
}) {
  const t = useTheme()
  return (
    <View
      testID={testID}
      style={{ borderWidth: 1, borderColor: t.border, borderRadius: t.radius, overflow: 'hidden', opacity: disabled ? 0.6 : 1 }}
    >
      {options.map((o, idx) => {
        const active = o.value === value
        return (
          <Pressable
            key={o.value}
            testID={testID ? `${testID}-${o.value}` : undefined}
            disabled={disabled}
            onPress={() => onChange(o.value)}
            style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingVertical: 11, paddingHorizontal: 12,
              backgroundColor: active ? t.sunken : 'transparent',
              borderTopWidth: idx > 0 ? 1 : 0, borderTopColor: t.border,
            }}
          >
            <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 13, color: active ? t.text : t.muted }}>
              {o.label}
            </Text>
            {active ? <Text style={{ fontFamily: t.mono(), fontSize: 13, color: t.primary }}>✓</Text> : null}
          </Pressable>
        )
      })}
    </View>
  )
}

// ─── sing-box form ─────────────────────────────────────────────────────────────

function SingboxForm({ mode, serverIdParam, editing }: {
  mode: 'create' | 'edit'
  serverIdParam: number | null
  editing: ProxyInboundFull | null
}) {
  const t = useTheme()
  const router = useRouter()
  const qc = useQueryClient()
  const isEdit = mode === 'edit'
  const isRelayEdit = isEdit && editing?.role === 'relay'

  // Seed once via lazy useState (mount-only) — never from an effect.
  const [protocol, setProtocol] = useState<string>(editing?.protocol ?? 'vless-reality')
  const [port, setPort] = useState<string>(String(editing?.port ?? randomPort()))
  const [alias, setAlias] = useState<string>(editing?.alias ?? '')
  const [uuid, setUUID] = useState<string>(editing?.uuid ?? randomUUID())
  const [password, setPassword] = useState<string>(editing?.password ?? '')
  const [sni, setSNI] = useState<string>(editing?.sni ?? '')
  const [transportPath, setTransportPath] = useState<string>(editing?.transport_path ?? '/proxy')
  const [transportHost, setTransportHost] = useState<string>(editing?.transport_host ?? '')
  const [privKey, setPrivKey] = useState<string>('') // never seeded — redacted
  const [pubKey, setPubKey] = useState<string>(editing?.reality_public_key ?? '')
  const [shortID, setShortID] = useState<string>(editing?.reality_short_id ?? '')
  const [hsServer, setHSServer] = useState<string>(editing?.reality_handshake_server ?? '')
  const [hsPort, setHSPort] = useState<string>(String(editing?.reality_handshake_port ?? '443'))
  const [ssMethod, setSSMethod] = useState<string>(editing?.ss_method ?? SINGBOX_SS_METHODS[0])
  const [ssPassword, setSSPassword] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Conditional visibility is DERIVED (useMemo), not effects.
  const groups = useMemo(() => ({
    uuid: needsUUID(protocol),
    password: needsPassword(protocol),
    reality: needsReality(protocol),
    certAndSNI: needsCertAndSNI(protocol),
    transport: needsTransport(protocol),
    ss: needsSS(protocol),
  }), [protocol])

  // On create, cert-requiring TLS protocols are deferred to web (no cert picker
  // on phone for v1). Edit of such a row is still allowed.
  const createBlocked = !isEdit && !singboxCreatableOnMobile(protocol)

  const genKeypair = async () => {
    try {
      const kp = await generateX25519()
      setPrivKey(kp.private_key)
      setPubKey(kp.public_key)
    } catch (e) { setError(e instanceof Error ? e.message : 'keygen failed') }
  }
  const genShortID = async () => {
    try { const r = await generateShortID(); setShortID(r.short_id) }
    catch (e) { setError(e instanceof Error ? e.message : 'short-id failed') }
  }

  const save = async () => {
    const portN = Number(port)
    if (!Number.isFinite(portN) || portN <= 0 || portN > 65535) { setError('port must be 1–65535'); return }
    setBusy(true); setError(null)

    const body: Record<string, unknown> = { port: portN, alias }
    if (groups.uuid) body.uuid = uuid
    if (groups.password) body.password = password
    if (groups.certAndSNI) body.sni = sni
    if (groups.transport) { body.transport_path = transportPath; body.transport_host = transportHost }
    if (groups.reality) {
      body.sni = sni
      // Only send the private key when freshly generated/typed; an empty value
      // on edit would (xray) wipe or (singbox) is ignored — omit to be safe.
      if (!isEdit || privKey !== '') body.reality_private_key = privKey
      body.reality_public_key = pubKey
      body.reality_short_id = shortID
      // Landing-only handshake fields — skip when editing a relay (relays don't
      // carry these; overwriting corrupts the row).
      if (!isRelayEdit) {
        body.reality_handshake_server = hsServer
        body.reality_handshake_port = Number(hsPort)
      }
    }
    if (groups.ss) { body.ss_method = ssMethod; body.ss_password = ssPassword }

    try {
      if (isEdit) {
        await patchInbound('singbox', editing!.id, body)
      } else {
        // never send tag (server-generated); create is always role=landing.
        await createInbound('singbox', { server_id: serverIdParam as number, role: 'landing', protocol, ...body } as never)
      }
      invalidateInbounds(qc, 'singbox')
      router.back()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally { setBusy(false) }
  }

  if (!isEdit && serverIdParam == null) {
    return <Empty>Pick a server: open this form from a server&apos;s + button.</Empty>
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 14 }}
      keyboardShouldPersistTaps="handled"
    >
      <Field label="Protocol">
        {isEdit ? (
          <Hint>{protocol} — protocol is immutable</Hint>
        ) : (
          <OptionList
            testID="protocol"
            value={protocol}
            options={SINGBOX_PROTOCOLS}
            onChange={(p) => { setProtocol(p); setError(null) }}
          />
        )}
      </Field>

      <Field label="Port" required>
        <Input testID="port" mono keyboardType="number-pad" value={port} onChangeText={setPort} placeholder="port" />
      </Field>
      <Field label="Alias">
        <Input testID="alias" mono value={alias} onChangeText={setAlias} autoCapitalize="none" autoCorrect={false} placeholder="optional label" />
      </Field>

      {groups.uuid ? (
        <Field label="UUID">
          <Input testID="uuid" mono value={uuid} onChangeText={setUUID} autoCapitalize="none" autoCorrect={false} />
          <Button variant="ghost" icon="rotate-cw" onPress={() => setUUID(randomUUID())}>New UUID</Button>
        </Field>
      ) : null}

      {groups.password ? (
        <Field label="Password">
          <Input testID="password" mono value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false} />
          <Button variant="ghost" icon="rotate-cw" onPress={() => setPassword(randomPassword())}>New password</Button>
        </Field>
      ) : null}

      {groups.reality ? (
        <Card>
          <View style={{ padding: 14, gap: 12 }}>
            <Text style={{ fontFamily: t.font(600), fontSize: 12.5, color: t.text }}>REALITY</Text>
            <Field label="SNI"><Input testID="sni" mono value={sni} onChangeText={setSNI} autoCapitalize="none" autoCorrect={false} placeholder="www.example.com" /></Field>
            <Field label="Public key"><Input testID="pubkey" mono value={pubKey} onChangeText={setPubKey} autoCapitalize="none" autoCorrect={false} /></Field>
            <Field label="Private key">
              <Input testID="privkey" mono value={privKey} onChangeText={setPrivKey} autoCapitalize="none" autoCorrect={false} placeholder={isEdit ? 'leave blank to keep stored key' : ''} />
            </Field>
            <Button variant="outline" icon="rotate-cw" onPress={() => { void genKeypair() }}>Generate keypair</Button>
            <Field label="Short ID"><Input testID="shortid" mono value={shortID} onChangeText={setShortID} autoCapitalize="none" autoCorrect={false} /></Field>
            <Button variant="outline" icon="rotate-cw" onPress={() => { void genShortID() }}>Generate short ID</Button>
            {isRelayEdit ? (
              <Hint>Editing a relay — handshake server/port inherited from the upstream landing.</Hint>
            ) : (
              <>
                <Field label="Handshake server"><Input testID="hsserver" mono value={hsServer} onChangeText={setHSServer} autoCapitalize="none" autoCorrect={false} placeholder="www.example.com" /></Field>
                <Field label="Handshake port"><Input testID="hsport" mono keyboardType="number-pad" value={hsPort} onChangeText={setHSPort} /></Field>
              </>
            )}
          </View>
        </Card>
      ) : null}

      {groups.certAndSNI ? (
        <Field label="SNI">
          <Input testID="sni" mono value={sni} onChangeText={setSNI} autoCapitalize="none" autoCorrect={false} placeholder="cert domain" />
          {!isEdit ? <Hint>Creating cert-backed TLS inbounds is web-only for now; this stays editable.</Hint> : null}
        </Field>
      ) : null}

      {groups.transport ? (
        <>
          <Field label="Transport path"><Input testID="tpath" mono value={transportPath} onChangeText={setTransportPath} autoCapitalize="none" autoCorrect={false} /></Field>
          <Field label="Transport host"><Input testID="thost" mono value={transportHost} onChangeText={setTransportHost} autoCapitalize="none" autoCorrect={false} placeholder="optional" /></Field>
        </>
      ) : null}

      {groups.ss ? (
        <>
          <Field label="Method">
            <OptionList
              testID="ssmethod"
              value={ssMethod}
              options={SINGBOX_SS_METHODS.map((m) => ({ value: m, label: m }))}
              onChange={(m) => { setSSMethod(m); setSSPassword('') }}
            />
          </Field>
          <Field label="Key">
            <Input testID="sspassword" mono value={ssPassword} onChangeText={setSSPassword} autoCapitalize="none" autoCorrect={false} placeholder={isEdit ? 'leave blank to keep' : ''} />
            <Button variant="ghost" icon="rotate-cw" onPress={() => setSSPassword(randomSSKey(ssMethod))}>New key</Button>
          </Field>
        </>
      ) : null}

      {createBlocked ? <ErrLine>Create this protocol on the web console (needs a TLS cert).</ErrLine> : null}
      {error ? <ErrLine>{error}</ErrLine> : null}

      <Button testID="save" variant="primary" icon="play" block disabled={busy || createBlocked} onPress={() => { void save() }}>
        {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create inbound'}
      </Button>
    </ScrollView>
  )
}

// ─── xray form ─────────────────────────────────────────────────────────────────

function XrayForm({ mode, serverIdParam, editing }: {
  mode: 'create' | 'edit'
  serverIdParam: number | null
  editing: ProxyInboundFull | null
}) {
  const t = useTheme()
  const router = useRouter()
  const qc = useQueryClient()
  const isEdit = mode === 'edit'

  const [protocol, setProtocol] = useState<string>(editing?.protocol ?? 'vless-reality')
  const [port, setPort] = useState<string>(String(editing?.port ?? randomPort()))
  const [alias, setAlias] = useState<string>(editing?.alias ?? '')
  const [uuid, setUUID] = useState<string>(editing?.uuid ?? randomUUID())
  const [sni, setSNI] = useState<string>(editing?.sni ?? 'www.lovelive-anime.jp')
  const [publicKey, setPublicKey] = useState<string>(editing?.public_key ?? '')
  const [privateKey, setPrivateKey] = useState<string>('') // redacted — never seeded
  const [shortID, setShortID] = useState<string>(editing?.short_id ?? '')
  const [wsPath, setWSPath] = useState<string>(editing?.ws_path ?? '/ws')
  const [ssMethod, setSSMethod] = useState<string>(editing?.ss_method ?? 'aes-256-gcm')
  const [ssPassword, setSSPassword] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const groups = useMemo(() => ({
    reality: xrayNeedsReality(protocol),
    ws: xrayNeedsWS(protocol),
    ss: xrayNeedsSS(protocol),
  }), [protocol])

  const genKeypair = async () => {
    try { const kp = await generateX25519(); setPrivateKey(kp.private_key); setPublicKey(kp.public_key) }
    catch (e) { setError(e instanceof Error ? e.message : 'keygen failed') }
  }
  const genShortID = async () => {
    try { const r = await generateShortID(); setShortID(r.short_id) }
    catch (e) { setError(e instanceof Error ? e.message : 'short-id failed') }
  }

  const save = async () => {
    const portN = Number(port)
    if (!Number.isFinite(portN) || portN <= 0 || portN > 65535) { setError('port must be 1–65535'); return }
    setBusy(true); setError(null)
    try {
      if (isEdit) {
        // Only send changed fields; private_key only when freshly typed (xray
        // does NOT guard empty — an empty value would wipe the REALITY key).
        const body: Record<string, unknown> = { port: portN }
        if (alias !== editing!.alias) body.alias = alias
        if (uuid !== (editing!.uuid ?? '')) body.uuid = uuid
        if (groups.reality) {
          if (sni !== (editing!.sni ?? '')) body.sni = sni
          if (publicKey !== (editing!.public_key ?? '')) body.public_key = publicKey
          if (privateKey) body.private_key = privateKey
          if (shortID !== (editing!.short_id ?? '')) body.short_id = shortID
        }
        if (groups.ws && wsPath !== (editing!.ws_path ?? '')) body.ws_path = wsPath
        if (groups.ss) {
          if (ssMethod !== (editing!.ss_method ?? '')) body.ss_method = ssMethod
          if (ssPassword) body.ss_password = ssPassword
        }
        await patchInbound('xray', editing!.id, body)
      } else {
        const body: Record<string, unknown> = {
          server_id: serverIdParam as number, port: portN, role: 'landing', protocol,
          alias: alias || undefined, uuid,
        }
        if (groups.reality) { body.sni = sni; body.public_key = publicKey; body.private_key = privateKey; body.short_id = shortID }
        if (groups.ws) body.ws_path = wsPath
        if (groups.ss) { body.ss_method = ssMethod; body.ss_password = ssPassword }
        await createInbound('xray', body as never)
      }
      invalidateInbounds(qc, 'xray')
      router.back()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally { setBusy(false) }
  }

  if (!isEdit && serverIdParam == null) {
    return <Empty>Pick a server: open this form from a server&apos;s + button.</Empty>
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 14 }}
      keyboardShouldPersistTaps="handled"
    >
      <Field label="Protocol">
        {isEdit ? (
          <Hint>{protocol} — protocol is immutable</Hint>
        ) : (
          <OptionList
            testID="protocol"
            value={protocol}
            options={XRAY_PROTOCOLS}
            onChange={(p) => { setProtocol(p); setError(null) }}
          />
        )}
      </Field>

      <Field label="Port" required>
        <Input testID="port" mono keyboardType="number-pad" value={port} onChangeText={setPort} placeholder="port" />
      </Field>
      <Field label="UUID">
        <Input testID="uuid" mono value={uuid} onChangeText={setUUID} autoCapitalize="none" autoCorrect={false} />
        <Button variant="ghost" icon="rotate-cw" onPress={() => setUUID(randomUUID())}>New UUID</Button>
      </Field>
      <Field label="Alias">
        <Input testID="alias" mono value={alias} onChangeText={setAlias} autoCapitalize="none" autoCorrect={false} placeholder="optional label" />
      </Field>

      {groups.reality ? (
        <Card>
          <View style={{ padding: 14, gap: 12 }}>
            <Text style={{ fontFamily: t.font(600), fontSize: 12.5, color: t.text }}>REALITY</Text>
            <Field label="SNI"><Input testID="sni" mono value={sni} onChangeText={setSNI} autoCapitalize="none" autoCorrect={false} /></Field>
            <Field label="Public key"><Input testID="pubkey" mono value={publicKey} onChangeText={setPublicKey} autoCapitalize="none" autoCorrect={false} /></Field>
            <Field label="Private key">
              <Input testID="privkey" mono value={privateKey} onChangeText={setPrivateKey} autoCapitalize="none" autoCorrect={false} placeholder={isEdit ? 'leave blank to keep stored key' : ''} />
            </Field>
            <Button variant="outline" icon="rotate-cw" onPress={() => { void genKeypair() }}>Generate keypair</Button>
            <Field label="Short ID"><Input testID="shortid" mono value={shortID} onChangeText={setShortID} autoCapitalize="none" autoCorrect={false} /></Field>
            <Button variant="outline" icon="rotate-cw" onPress={() => { void genShortID() }}>Generate short ID</Button>
          </View>
        </Card>
      ) : null}

      {groups.ws ? (
        <Field label="WebSocket path"><Input testID="wspath" mono value={wsPath} onChangeText={setWSPath} autoCapitalize="none" autoCorrect={false} /></Field>
      ) : null}

      {groups.ss ? (
        <>
          <Field label="Method">
            <OptionList
              testID="ssmethod"
              value={ssMethod}
              options={XRAY_SS_METHODS.map((m) => ({ value: m, label: m }))}
              onChange={(m) => { setSSMethod(m); setSSPassword('') }}
            />
          </Field>
          <Field label="Password / key">
            <Input testID="sspassword" mono value={ssPassword} onChangeText={setSSPassword} autoCapitalize="none" autoCorrect={false} placeholder={isEdit ? 'leave blank to keep' : ''} />
            <Button variant="ghost" icon="rotate-cw" onPress={() => setSSPassword(randomSSKey(ssMethod))}>New key</Button>
          </Field>
        </>
      ) : null}

      {error ? <ErrLine>{error}</ErrLine> : null}
      <Button testID="save" variant="primary" icon="play" block disabled={busy} onPress={() => { void save() }}>
        {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create inbound'}
      </Button>
    </ScrollView>
  )
}

// ─── screen ─────────────────────────────────────────────────────────────────────

export default function InboundFormScreen() {
  const params = useLocalSearchParams<{ id: string; mode?: string; inboundId?: string; serverId?: string }>()
  const router = useRouter()
  const id = params.id
  const mode: 'create' | 'edit' = params.mode === 'edit' ? 'edit' : 'create'
  const inboundId = params.inboundId ? Number(params.inboundId) : null
  const serverIdParam = params.serverId ? Number(params.serverId) : null

  const plugin: ProxyPluginID = isInboundsPlugin(id) ? id : 'singbox'
  // Seed the edit row from the cached list query (mount-once via lazy useState in
  // the form bodies; here we just look it up once for the initial render).
  const cached = useInbounds(plugin).data
  const editing = useMemo<ProxyInboundFull | null>(
    () => (mode === 'edit' && inboundId != null ? (cached?.find((i) => i.id === inboundId) ?? null) : null),
    [mode, inboundId, cached],
  )

  const title = mode === 'edit' ? 'Edit inbound' : 'New inbound'

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title }} />
      <NavBar title={title} onBack={() => router.back()} backLabel="Inbounds" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {!isInboundsPlugin(id) ? (
          <Empty>Inbounds are only available for sing-box and xray.</Empty>
        ) : mode === 'edit' && editing == null ? (
          <Empty>Inbound not found — go back and reopen from the list.</Empty>
        ) : plugin === 'xray' ? (
          <XrayForm mode={mode} serverIdParam={serverIdParam} editing={editing} />
        ) : (
          <SingboxForm mode={mode} serverIdParam={serverIdParam} editing={editing} />
        )}
      </KeyboardAvoidingView>
    </Screen>
  )
}
