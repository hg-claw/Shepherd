import { useMemo, useState } from 'react'
import {
  View, Text, ScrollView, ActivityIndicator, RefreshControl,
  KeyboardAvoidingView, Platform, Pressable,
} from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import { usePluginConfig, savePluginConfig } from '@/api/plugins'
import {
  useCfZones, useCfRecords, createCfRecord, deleteCfRecord,
  useHostDomains, addHostDomain, removeHostDomain,
  type CfZone, type CfRecord, type HostDomain,
} from '@/api/cloudflare'
import { useServers, type ServerRow } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { cmpStr, relTime } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import {
  NavBar, Card, CardHead, Pill, Button, Field, Input, Hint, ErrLine, Empty,
  Icon,
} from '@/components/ds'

type Tab = 'setup' | 'zones' | 'dns' | 'hosts' | 'activity'
const TABS: { value: Tab; label: string }[] = [
  { value: 'setup', label: 'Setup' },
  { value: 'zones', label: 'Zones' },
  { value: 'dns', label: 'DNS' },
  { value: 'hosts', label: 'Hosts' },
  { value: 'activity', label: 'Activity' },
]

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX']

// errMsg pulls a human string off whatever the mutation threw (APIError carries
// the backend's {error} message — surface it rather than swallow it).
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ── shared bits ───────────────────────────────────────────────────────────────

function ErrorRetry({ children, onRetry }: { children: string; onRetry: () => void }) {
  const t = useTheme()
  return (
    <View style={{ alignItems: 'center', gap: 12, padding: t.space(6) }}>
      <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.err, textAlign: 'center' }}>{children}</Text>
      <Button variant="outline" icon="refresh-cw" onPress={onRetry}>Retry</Button>
    </View>
  )
}

// Top tab switcher — horizontally scrollable so 5 tabs fit on a phone. Mirrors the
// ds Segmented look (bordered group, active = sunken) without the alignSelf clamp.
function TabSwitcher({ value, onChange }: { value: Tab; onChange: (v: Tab) => void }) {
  const t = useTheme()
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: t.border, backgroundColor: t.surface }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 12, paddingVertical: 9, alignItems: 'center' }}
    >
      {TABS.map((o) => {
        const active = o.value === value
        return (
          <Pressable
            key={o.value}
            testID={`tab-${o.value}`}
            onPress={() => onChange(o.value)}
            style={{
              height: 30, paddingHorizontal: 14, borderRadius: t.radius, justifyContent: 'center',
              backgroundColor: active ? t.sunken : 'transparent',
              borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
            }}
          >
            <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>
              {o.label}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

// ── Setup ───────────────────────────────────────────────────────────────────────

function SetupTab() {
  const t = useTheme()
  const cfgQ = usePluginConfig('cloudflare')

  if (cfgQ.isLoading) {
    return <ActivityIndicator testID="setup-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (cfgQ.isError) {
    return <ErrorRetry onRetry={() => { void cfgQ.refetch() }}>Failed to load config.</ErrorRetry>
  }
  return <SetupForm initial={cfgQ.data ?? {}} onSaved={() => { void cfgQ.refetch() }} />
}

function SetupForm({ initial, onSaved }: { initial: Record<string, unknown>; onSaved: () => void }) {
  const t = useTheme()
  // Seed once from the loaded config — config is already resolved here so this is a
  // lazy useState initializer, NOT a setState-in-effect.
  const [token, setToken] = useState(() => String(initial.api_token ?? ''))
  const [accountID, setAccountID] = useState(() => String(initial.account_id ?? ''))
  const [zoneID, setZoneID] = useState(() => String(initial.zone_id ?? ''))
  const [prefix, setPrefix] = useState(() => String(initial.prefix ?? ''))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Zones populate the picker once a token exists; the redaction sentinel still
  // produces a valid auth header server-side, so a non-empty token is enough.
  const zonesQ = useCfZones(!!token)
  const zones = useMemo(
    () => [...(zonesQ.data ?? [])].sort((a, b) => cmpStr(a.name, b.name)),
    [zonesQ.data],
  )

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await savePluginConfig('cloudflare', { api_token: token, account_id: accountID, zone_id: zoneID, prefix })
      onSaved()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 14 }}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="API token">
          <Input
            testID="setup-token"
            mono
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="cf-token"
          />
          <Hint>Scoped token (Zone:Read + DNS:Edit). Stored on the server; never sent to the browser.</Hint>
        </Field>

        <Field label="Account ID (optional)">
          <Input
            testID="setup-account"
            mono
            value={accountID}
            onChangeText={setAccountID}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>

        <Field label="Default zone">
          {/* No <select> in RN — a tap-to-select chip list of zones from /zones. */}
          {!token ? (
            <Hint>Enter and save a token to load zones.</Hint>
          ) : zonesQ.isLoading ? (
            <ActivityIndicator testID="setup-zones-loading" color={t.primary} style={{ alignSelf: 'flex-start' }} />
          ) : zonesQ.isError ? (
            <ErrLine>Failed to load zones: {errMsg(zonesQ.error)}</ErrLine>
          ) : zones.length === 0 ? (
            <Hint>No zones — check the token scope.</Hint>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {zones.map((z) => {
                const active = z.id === zoneID
                return (
                  <Pressable
                    key={z.id}
                    testID={`setup-zone-${z.id}`}
                    onPress={() => setZoneID(active ? '' : z.id)}
                    style={{
                      height: 30, paddingHorizontal: 12, borderRadius: t.radius, justifyContent: 'center',
                      backgroundColor: active ? t.sunken : 'transparent',
                      borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
                    }}
                  >
                    <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>
                      {z.name}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          )}
          <Hint>Default zone used for per-host domain mappings on the Hosts tab.</Hint>
        </Field>

        <Field label="Subdomain prefix">
          <Input
            testID="setup-prefix"
            mono
            value={prefix}
            onChangeText={setPrefix}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="hosts"
          />
          <Hint>Used when auto-generating per-host domains: {'{server}.{prefix}.{zone}'}.</Hint>
        </Field>

        {error ? <ErrLine>{error}</ErrLine> : null}
        <Button testID="setup-save" variant="primary" icon="play" block disabled={busy} onPress={save}>Save</Button>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

// ── Zones ─────────────────────────────────────────────────────────────────────

function ZoneRow({ zone }: { zone: CfZone }) {
  const t = useTheme()
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 4, borderTopWidth: 1, borderTopColor: t.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.mono(500), fontSize: t.fs.sm, color: t.text }}>
          {zone.name}
        </Text>
        {zone.status ? <Pill kind={zone.status === 'active' ? 'ok' : 'neutral'}>{zone.status}</Pill> : null}
        <Text style={{ marginLeft: 'auto', fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          {zone.plan?.name ?? '—'}
        </Text>
      </View>
      <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim }}>{zone.id}</Text>
    </View>
  )
}

function ZonesTab() {
  const t = useTheme()
  const zonesQ = useCfZones()
  const zones = useMemo(
    () => [...(zonesQ.data ?? [])].sort((a, b) => cmpStr(a.name, b.name)),
    [zonesQ.data],
  )
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44 }}
      refreshControl={<RefreshControl refreshing={zonesQ.isRefetching} onRefresh={() => { void zonesQ.refetch() }} tintColor={t.primary} />}
    >
      <Card>
        <CardHead>Zones</CardHead>
        {zonesQ.isLoading ? (
          <ActivityIndicator testID="zones-loading" color={t.primary} style={{ marginVertical: 24 }} />
        ) : zonesQ.isError ? (
          <ErrorRetry onRetry={() => { void zonesQ.refetch() }}>{`Failed to load zones: ${errMsg(zonesQ.error)}`}</ErrorRetry>
        ) : zones.length === 0 ? (
          <Empty>No zones.</Empty>
        ) : (
          zones.map((z) => <ZoneRow key={z.id} zone={z} />)
        )}
      </Card>
    </ScrollView>
  )
}

// ── DNS ───────────────────────────────────────────────────────────────────────

export function fmtTTL(ttl?: number): string {
  if (ttl == null) return '—'
  if (ttl === 1) return 'auto'
  return String(ttl)
}

function ZoneChips({ zones, zoneID, onPick }: { zones: CfZone[]; zoneID: string; onPick: (id: string) => void }) {
  const t = useTheme()
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: t.border }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 14, paddingVertical: 9, alignItems: 'center' }}
    >
      {zones.map((z) => {
        const active = z.id === zoneID
        return (
          <Pressable
            key={z.id}
            testID={`zone-${z.id}`}
            onPress={() => onPick(z.id)}
            style={{
              height: 30, paddingHorizontal: 12, borderRadius: t.radius, justifyContent: 'center',
              backgroundColor: active ? t.sunken : 'transparent',
              borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
            }}
          >
            <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>
              {z.name}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

function RecordRow({ record, onDelete, pending }: { record: CfRecord; onDelete: () => void; pending: boolean }) {
  const t = useTheme()
  return (
    <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 4, borderTopWidth: 1, borderTopColor: t.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.mono(500), fontSize: t.fs.sm, color: t.text }}>
          {record.name}
        </Text>
        <Pill kind="neutral">{record.type}</Pill>
        <Text style={{ marginLeft: 'auto', fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          ttl {fmtTTL(record.ttl)}
        </Text>
        <Pressable
          testID={`record-del-${record.id}`}
          accessibilityRole="button"
          accessibilityLabel="delete record"
          disabled={pending}
          onPress={onDelete}
          style={({ pressed }) => ({
            width: 30, height: 30, borderRadius: t.radius, alignItems: 'center', justifyContent: 'center',
            backgroundColor: pressed ? t.sunken : 'transparent', opacity: pending ? 0.5 : 1,
          })}
        >
          <Icon name="x" size={16} color={t.destructive} />
        </Pressable>
      </View>
      <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim }}>{record.content}</Text>
    </View>
  )
}

function DnsTab() {
  const t = useTheme()
  const zonesQ = useCfZones()
  const zones = useMemo(
    () => [...(zonesQ.data ?? [])].sort((a, b) => cmpStr(a.name, b.name)),
    [zonesQ.data],
  )
  // Effective zone derived (picked wins, else the first zone) — NEVER a setState
  // effect, matching the host-picker idiom in status.tsx.
  const [picked, setPicked] = useState<string | null>(null)
  const zoneID = picked ?? zones[0]?.id ?? ''

  const recsQ = useCfRecords(zoneID)
  const records = useMemo(
    () => [...(recsQ.data ?? [])].sort((a, b) => cmpStr(a.name, b.name)),
    [recsQ.data],
  )

  // Inline "add record" draft (no Modal in the ds kit).
  const [draftName, setDraftName] = useState('')
  const [draftType, setDraftType] = useState('A')
  const [draftContent, setDraftContent] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [delBusy, setDelBusy] = useState(false)

  const canAdd = !!draftName && !!draftContent && !!zoneID && !busy

  const onAdd = async () => {
    setBusy(true); setError(null)
    try {
      await createCfRecord(zoneID, { type: draftType, name: draftName, content: draftContent, ttl: 1, proxied: false })
      setDraftName(''); setDraftContent(''); setDraftType('A')
      await recsQ.refetch()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (rid: string) => {
    setDelBusy(true); setError(null)
    try {
      await deleteCfRecord(zoneID, rid)
      await recsQ.refetch()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setDelBusy(false)
    }
  }

  if (zonesQ.isLoading) {
    return <ActivityIndicator testID="dns-zones-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (zonesQ.isError) {
    return <ErrorRetry onRetry={() => { void zonesQ.refetch() }}>{`Failed to load zones: ${errMsg(zonesQ.error)}`}</ErrorRetry>
  }
  if (zones.length === 0) return <Empty>No zones — configure a token on the Setup tab.</Empty>

  return (
    <View style={{ flex: 1 }}>
      <ZoneChips zones={zones} zoneID={zoneID} onPick={setPicked} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={recsQ.isRefetching} onRefresh={() => { void recsQ.refetch() }} tintColor={t.primary} />}
        >
          <Card>
            <CardHead>Records</CardHead>
            {recsQ.isLoading ? (
              <ActivityIndicator testID="records-loading" color={t.primary} style={{ marginVertical: 24 }} />
            ) : recsQ.isError ? (
              <ErrorRetry onRetry={() => { void recsQ.refetch() }}>{`Failed to load records: ${errMsg(recsQ.error)}`}</ErrorRetry>
            ) : records.length === 0 ? (
              <Empty>No records.</Empty>
            ) : (
              records.map((r) => (
                <RecordRow key={r.id} record={r} pending={delBusy} onDelete={() => { void onDelete(r.id) }} />
              ))
            )}
          </Card>

          <Card>
            <CardHead>Add record</CardHead>
            <View style={{ padding: 14, gap: 12 }}>
              <Field label="name">
                <Input
                  testID="dns-name"
                  mono
                  value={draftName}
                  onChangeText={setDraftName}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="record name"
                />
              </Field>
              <Field label="type">
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {RECORD_TYPES.map((rt) => {
                    const active = rt === draftType
                    return (
                      <Pressable
                        key={rt}
                        testID={`dns-type-${rt}`}
                        onPress={() => setDraftType(rt)}
                        style={{
                          height: 30, paddingHorizontal: 12, borderRadius: t.radius, justifyContent: 'center',
                          backgroundColor: active ? t.sunken : 'transparent',
                          borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
                        }}
                      >
                        <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>{rt}</Text>
                      </Pressable>
                    )
                  })}
                </View>
              </Field>
              <Field label="content">
                <Input
                  testID="dns-content"
                  mono
                  value={draftContent}
                  onChangeText={setDraftContent}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="content"
                />
              </Field>
              <Hint>TTL is auto and proxy is off (matching the web defaults).</Hint>
              {error ? <ErrLine>{error}</ErrLine> : null}
              <Button testID="dns-add" variant="primary" icon="plus" block disabled={!canAdd} onPress={onAdd}>Add</Button>
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

// ── Hosts ─────────────────────────────────────────────────────────────────────

function HostServerCard({
  server, domains, onAddDefault, onAddCustom, onRemove, pending,
}: {
  server: ServerRow
  domains: HostDomain[]
  onAddDefault: () => void
  onAddCustom: (domain: string) => void
  onRemove: (id: number) => void
  pending: boolean
}) {
  const t = useTheme()
  const [draft, setDraft] = useState('')
  const sshHost = nullStr(server.ssh_host) || '—'
  return (
    <Card>
      <CardHead>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>{server.name}</Text>
          <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim, marginTop: 1 }}>{sshHost}</Text>
        </View>
        <Button testID={`host-default-${server.id}`} variant="outline" icon="plus" disabled={pending} onPress={onAddDefault}>default</Button>
      </CardHead>

      {domains.length === 0 ? (
        <Empty>no domains</Empty>
      ) : (
        domains.map((d) => (
          <View
            key={String(d.id)}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontFamily: t.mono(500), fontSize: t.fs.sm, color: t.text }}>{d.domain}</Text>
              <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim, marginTop: 1 }}>
                → {d.content} ({d.type}) · {relTime(d.created_at)}
              </Text>
            </View>
            <Pressable
              testID={`host-del-${d.id}`}
              accessibilityRole="button"
              accessibilityLabel="remove domain"
              disabled={pending}
              onPress={() => onRemove(d.id)}
              style={({ pressed }) => ({
                width: 30, height: 30, borderRadius: t.radius, alignItems: 'center', justifyContent: 'center',
                backgroundColor: pressed ? t.sunken : 'transparent', opacity: pending ? 0.5 : 1,
              })}
            >
              <Icon name="x" size={16} color={t.destructive} />
            </Pressable>
          </View>
        ))
      )}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, borderTopWidth: 1, borderTopColor: t.border }}>
        <Input
          testID={`host-input-${server.id}`}
          mono
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="custom.example.com"
          style={{ flex: 1, height: 36, fontSize: 12.5 }}
        />
        <Button
          testID={`host-add-${server.id}`}
          variant="outline"
          icon="plus"
          disabled={!draft || pending}
          onPress={() => { onAddCustom(draft); setDraft('') }}
        >
          add
        </Button>
      </View>
    </Card>
  )
}

function HostsTab() {
  const t = useTheme()
  const serversQ = useServers()
  const domainsQ = useHostDomains()
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  const byServer = useMemo(() => {
    const m = new Map<number, HostDomain[]>()
    for (const d of domainsQ.data ?? []) {
      const arr = m.get(d.server_id) ?? []
      arr.push(d)
      m.set(d.server_id, arr)
    }
    // Backend ORDER BY server_id, domain — preserve with a code-unit re-sort.
    for (const arr of m.values()) arr.sort((a, b) => cmpStr(a.domain, b.domain))
    return m
  }, [domainsQ.data])

  const servers = serversQ.data ?? []

  const runAdd = async (body: { server_id: number; domain?: string }) => {
    setPending(true); setError(null)
    try {
      await addHostDomain(body)
      await domainsQ.refetch()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setPending(false)
    }
  }

  const runRemove = async (id: number) => {
    setPending(true); setError(null)
    try {
      await removeHostDomain(id)
      await domainsQ.refetch()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setPending(false)
    }
  }

  if (serversQ.isLoading) {
    return <ActivityIndicator testID="hosts-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (serversQ.isError) {
    return <ErrorRetry onRetry={() => { void serversQ.refetch() }}>Failed to load servers.</ErrorRetry>
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={serversQ.isRefetching || domainsQ.isRefetching}
            onRefresh={() => { void serversQ.refetch(); void domainsQ.refetch() }}
            tintColor={t.primary}
          />
        }
      >
        <Text style={{ fontFamily: t.font(), fontSize: 12.5, color: t.muted }}>
          Per-server domain mappings. &quot;default&quot; creates {'{server}.{prefix}.{zone}'} → the server&apos;s SSH host; add custom domains via the input.
        </Text>
        {error ? <ErrLine>{error}</ErrLine> : null}
        {servers.length === 0 ? (
          <Empty>No servers.</Empty>
        ) : (
          servers.map((s) => (
            <HostServerCard
              key={String(s.id)}
              server={s}
              domains={byServer.get(s.id) ?? []}
              pending={pending}
              onAddDefault={() => { void runAdd({ server_id: s.id }) }}
              onAddCustom={(domain) => { void runAdd({ server_id: s.id, domain }) }}
              onRemove={(id) => { void runRemove(id) }}
            />
          ))
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

// ── Activity (placeholder, mirrors web — no endpoint wired) ─────────────────────

function ActivityTab() {
  const t = useTheme()
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.muted, lineHeight: 20 }}>
        Cloudflare audit log integration is tracked separately — this tab will surface the most recent events once the audit endpoint is wired up.
      </Text>
    </ScrollView>
  )
}

// ── screen ────────────────────────────────────────────────────────────────────

export default function CloudflareScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const [tab, setTab] = useState<Tab>('setup')

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Cloudflare' }} />
      <NavBar title="Cloudflare" onBack={() => router.back()} backLabel="Plugin" />
      {id !== 'cloudflare' ? (
        <Empty>This view is only available for the Cloudflare plugin.</Empty>
      ) : (
        <>
          <TabSwitcher value={tab} onChange={setTab} />
          {tab === 'setup' ? <SetupTab />
            : tab === 'zones' ? <ZonesTab />
            : tab === 'dns' ? <DnsTab />
            : tab === 'hosts' ? <HostsTab />
            : <ActivityTab />}
        </>
      )}
    </Screen>
  )
}
