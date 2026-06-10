import { useMemo, useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Alert } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import {
  useNetqualityLatest, type NetqualityISP, type NetqualityLatestRow,
} from '@/api/plugins'
import {
  useNetqualityHostConfigs, useNetqualityTargets,
  putNetqualityHost, patchNetqualityTarget, deleteNetqualityTarget,
  type NetqualityHostConfig, type NetqualityTarget,
} from '@/api/netquality'
import { useServers, type ServerRow } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { cmpStr, relTime } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, CardHead, Pill, Switch, Segmented, Button, Empty, type PillKind } from '@/components/ds'

// ── ISP grouping (matches web's TargetsTab / ResultsTab order + Chinese labels) ─
const ISP_ORDER: NetqualityISP[] = ['telecom', 'unicom', 'mobile', 'overseas']
const ISP_LABEL: Record<NetqualityISP, string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  overseas: '海外',
}

// Interval choices mirror web's HostsTab select (1/3/5/10/30 min).
const INTERVALS: { value: string; label: string }[] = [
  { value: '60', label: '1m' },
  { value: '180', label: '3m' },
  { value: '300', label: '5m' },
  { value: '600', label: '10m' },
  { value: '1800', label: '30m' },
]

type Section = 'hosts' | 'targets' | 'results'

// ── pure helpers (exported for tests) ────────────────────────────────────────

// Latency tone thresholds mirror the web ResultsTab: loss ≥50% → err,
// RTT ≥250ms → err, ≥150ms → warn, else ok; no sample → neutral.
export function rttKind(rttMs?: number, lossPct?: number): PillKind {
  if (lossPct != null && lossPct >= 50) return 'err'
  if (rttMs == null) return 'neutral'
  if (rttMs >= 250) return 'err'
  if (rttMs >= 150) return 'warn'
  return 'ok'
}

export function fmtRTT(rtt?: number): string {
  return rtt == null ? '—' : `${rtt.toFixed(1)} ms`
}

export function fmtLoss(loss?: number): string {
  return loss == null ? '—' : `${loss.toFixed(0)}%`
}

// intervalLabel renders the human label for a sample interval; falls back to a
// raw "Ns" when the server returns a value outside the standard set.
export function intervalLabel(seconds: number): string {
  return INTERVALS.find((i) => i.value === String(seconds))?.label ?? `${seconds}s`
}

// serverLabel resolves a server's display name through the servers join.
// public_alias is a Go sql.NullString → must go through nullStr().
function serverLabel(servers: ServerRow[], sid: number): string {
  const s = servers.find((x) => x.id === sid)
  return s ? (nullStr(s.public_alias) || s.name || `#${sid}`) : `#${sid}`
}

// ── shared bits ───────────────────────────────────────────────────────────────

function ErrorRetry({ children, onRetry }: { children: string; onRetry: () => void }) {
  const t = useTheme()
  return (
    <View style={{ alignItems: 'center', gap: 12, padding: t.space(6) }}>
      <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.err }}>{children}</Text>
      <Button variant="outline" icon="refresh-cw" onPress={onRetry}>Retry</Button>
    </View>
  )
}

// Host picker chips — same pattern as status.tsx; here over the probe-config
// hosts (server_id is the stable key, every config row has one).
function HostChips({ hosts, serverID, onPick }: {
  hosts: { server_id: number }[]
  serverID: number | null
  onPick: (sid: number) => void
}) {
  const t = useTheme()
  const servers = useServers().data ?? []
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ flexGrow: 0, borderBottomWidth: 1, borderBottomColor: t.border }}
      contentContainerStyle={{ gap: 6, paddingHorizontal: 14, paddingVertical: 9, alignItems: 'center' }}
    >
      {hosts.map((h) => {
        const active = h.server_id === serverID
        return (
          <Pressable
            key={String(h.server_id)}
            testID={`host-${h.server_id}`}
            onPress={() => onPick(h.server_id)}
            style={{
              height: 30, paddingHorizontal: 12, borderRadius: t.radius, justifyContent: 'center',
              backgroundColor: active ? t.sunken : 'transparent',
              borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
            }}
          >
            <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>
              {serverLabel(servers, h.server_id)}
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

// ── Hosts section ──────────────────────────────────────────────────────────────

function HostCard({ server, cfg, onEnable, onInterval, onTargets, busy }: {
  server: ServerRow
  cfg?: NetqualityHostConfig
  onEnable: (next: boolean) => void
  onInterval: (seconds: number) => void
  onTargets: () => void
  busy: boolean
}) {
  const t = useTheme()
  const enabled = cfg?.enabled ?? false
  const interval = cfg?.sample_interval_seconds ?? 300
  const label = nullStr(server.public_alias) || server.name || `#${server.id}`
  return (
    <Card style={{ padding: 14, gap: 12 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.mono(500), fontSize: t.fs.md, color: t.text }}>
          {label}
        </Text>
        {busy ? <ActivityIndicator size="small" color={t.primary} testID={`host-busy-${server.id}`} /> : null}
        <Switch testID={`host-enable-${server.id}`} on={enabled} disabled={busy} onChange={onEnable} />
      </View>
      {enabled ? (
        <View style={{ gap: 8 }}>
          <Text style={{ fontFamily: t.font(), fontSize: t.fs.xs, color: t.muted }}>Sample interval</Text>
          <Segmented
            value={String(interval)}
            onChange={(v) => onInterval(Number(v))}
            options={INTERVALS}
          />
          <Button
            testID={`host-targets-${server.id}`}
            variant="outline"
            icon="target"
            onPress={onTargets}
          >
            Targets
          </Button>
        </View>
      ) : null}
      {cfg?.last_error ? (
        <Text testID={`host-err-${server.id}`} style={{ fontFamily: t.mono(), fontSize: 12, color: t.err }}>
          {cfg.last_error}
        </Text>
      ) : null}
      {cfg?.updated_at ? (
        <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim }}>
          updated {relTime(cfg.updated_at)}
        </Text>
      ) : null}
    </Card>
  )
}

function HostsSection() {
  const t = useTheme()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const serversQ = useServers()
  const cfgQ = useNetqualityHostConfigs()
  const [busy, setBusy] = useState<number | null>(null)

  const cfgByServer = useMemo(() => {
    const m = new Map<number, NetqualityHostConfig>()
    for (const c of cfgQ.data ?? []) m.set(c.server_id, c)
    return m
  }, [cfgQ.data])

  const servers = useMemo(() => {
    const list = [...(serversQ.data ?? [])]
    list.sort((a, b) => cmpStr(nullStr(a.public_alias) || a.name, nullStr(b.public_alias) || b.name))
    return list
  }, [serversQ.data])

  const refreshing = serversQ.isRefetching || cfgQ.isRefetching
  const onRefresh = () => { void serversQ.refetch(); void cfgQ.refetch() }

  const run = async (sid: number, fn: () => Promise<unknown>) => {
    if (busy != null) return
    setBusy(sid)
    try { await fn(); await cfgQ.refetch() }
    catch (e) { Alert.alert('Update failed', e instanceof Error ? e.message : 'request failed') }
    finally { setBusy(null) }
  }

  const setEnabled = (sid: number, cfg: NetqualityHostConfig | undefined, next: boolean) => {
    void run(sid, () => putNetqualityHost(sid, {
      enabled: next,
      sample_interval_seconds: cfg?.sample_interval_seconds ?? 300,
    }))
  }
  const setInterval = (sid: number, seconds: number) => {
    void run(sid, () => putNetqualityHost(sid, { enabled: true, sample_interval_seconds: seconds }))
  }

  if (serversQ.isLoading || cfgQ.isLoading) {
    return <ActivityIndicator testID="hosts-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (serversQ.isError) {
    return <ErrorRetry onRetry={() => { void serversQ.refetch() }}>Failed to load servers.</ErrorRetry>
  }
  if (cfgQ.isError) {
    return <ErrorRetry onRetry={() => { void cfgQ.refetch() }}>Failed to load probe config.</ErrorRetry>
  }
  if (servers.length === 0) return <Empty>No servers registered.</Empty>

  const enabledCount = (cfgQ.data ?? []).filter((c) => c.enabled).length

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 12 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
    >
      <Text testID="hosts-count" style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim }}>
        {enabledCount} probing · {servers.length} {servers.length === 1 ? 'server' : 'servers'}
      </Text>
      {servers.map((s) => (
        <HostCard
          key={String(s.id)}
          server={s}
          cfg={cfgByServer.get(s.id)}
          busy={busy === s.id}
          onEnable={(next) => setEnabled(s.id, cfgByServer.get(s.id), next)}
          onInterval={(seconds) => setInterval(s.id, seconds)}
          onTargets={() => router.push(`/(app)/plugin/${id}/nq-host-targets?serverId=${s.id}`)}
        />
      ))}
    </ScrollView>
  )
}

// ── Targets section ────────────────────────────────────────────────────────────

function TargetRow({ target, onToggle, onDelete, busy }: {
  target: NetqualityTarget
  onToggle: (next: boolean) => void
  onDelete: () => void
  busy: boolean
}) {
  const t = useTheme()
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border,
    }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.font(500), fontSize: t.fs.sm, color: t.text }}>
            {target.label}
          </Text>
          <Pill kind={target.source === 'custom' ? 'ok' : 'neutral'}>{target.source}</Pill>
        </View>
        <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted, marginTop: 2 }}>
          {target.region}{target.region ? ' · ' : ''}{target.host}
        </Text>
      </View>
      <Switch testID={`target-enable-${target.id}`} on={target.enabled} disabled={busy} onChange={onToggle} />
      {target.source === 'custom' ? (
        <Button testID={`target-delete-${target.id}`} variant="ghost" icon="x" disabled={busy} onPress={onDelete}>
          {'Delete'}
        </Button>
      ) : null}
    </View>
  )
}

function TargetsSection() {
  const t = useTheme()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const targetsQ = useNetqualityTargets()
  const [busy, setBusy] = useState<number | null>(null)

  const grouped = useMemo(() => {
    const m = new Map<NetqualityISP, NetqualityTarget[]>()
    for (const r of targetsQ.data ?? []) {
      const arr = m.get(r.isp) ?? []
      arr.push(r)
      m.set(r.isp, arr)
    }
    // builtins first, then by label (cmpStr — Hermes has no localeCompare).
    for (const arr of m.values()) {
      arr.sort((a, b) => {
        if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1
        return cmpStr(a.label, b.label)
      })
    }
    return m
  }, [targetsQ.data])

  const run = async (tid: number, fn: () => Promise<unknown>) => {
    if (busy != null) return
    setBusy(tid)
    try { await fn(); await targetsQ.refetch() }
    catch (e) { Alert.alert('Update failed', e instanceof Error ? e.message : 'request failed') }
    finally { setBusy(null) }
  }

  const confirmDelete = (target: NetqualityTarget) => {
    Alert.alert(
      `Delete "${target.label}"?`,
      'This permanently removes the custom target.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { void run(target.id, () => deleteNetqualityTarget(target.id)) } },
      ],
    )
  }

  if (targetsQ.isLoading) {
    return <ActivityIndicator testID="targets-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (targetsQ.isError) {
    return <ErrorRetry onRetry={() => { void targetsQ.refetch() }}>Failed to load targets.</ErrorRetry>
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
      refreshControl={<RefreshControl refreshing={targetsQ.isRefetching} onRefresh={targetsQ.refetch} tintColor={t.primary} />}
    >
      <Button
        testID="target-add"
        variant="outline"
        icon="plus"
        block
        onPress={() => router.push(`/(app)/plugin/${id}/nq-target-new`)}
      >
        Add custom target
      </Button>
      {ISP_ORDER.map((isp) => {
        const rows = grouped.get(isp) ?? []
        if (rows.length === 0) return null
        return (
          <Card key={isp}>
            <CardHead>{`${ISP_LABEL[isp]} (${rows.length})`}</CardHead>
            {rows.map((r) => (
              <TargetRow
                key={String(r.id)}
                target={r}
                busy={busy === r.id}
                onToggle={(next) => { void run(r.id, () => patchNetqualityTarget(r.id, { enabled: next })) }}
                onDelete={() => confirmDelete(r)}
              />
            ))}
          </Card>
        )
      })}
    </ScrollView>
  )
}

// ── Results section (latest samples grid) ──────────────────────────────────────

function NetqualityRow({ row }: { row: NetqualityLatestRow }) {
  const t = useTheme()
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border,
    }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.sm, color: t.text }}>
          {row.label}
        </Text>
        <Text numberOfLines={1} style={{ fontFamily: t.font(), fontSize: t.fs.xs, color: t.muted, marginTop: 1 }}>
          {row.region}{row.ts ? ` · ${relTime(row.ts)}` : ''}
        </Text>
      </View>
      <Pill kind={rttKind(row.rtt_avg_ms, row.loss_pct)}>{fmtRTT(row.rtt_avg_ms)}</Pill>
      <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>{fmtLoss(row.loss_pct)}</Text>
    </View>
  )
}

function ResultsSection() {
  const t = useTheme()
  const cfgQ = useNetqualityHostConfigs()
  const hosts = cfgQ.data ?? []
  const [picked, setPicked] = useState<number | null>(null)
  // Default to the first enabled host (or the first config row) — derived, no effect.
  const serverID = picked ?? hosts.find((h) => h.enabled)?.server_id ?? hosts[0]?.server_id ?? null
  // 10s refetch matches web's ResultsTab auto-refresh.
  const latestQ = useNetqualityLatest(serverID)

  const grouped = useMemo(() => {
    const m = new Map<NetqualityISP, NetqualityLatestRow[]>()
    for (const r of latestQ.data ?? []) {
      const arr = m.get(r.isp) ?? []
      arr.push(r)
      m.set(r.isp, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => cmpStr(a.label, b.label))
    return m
  }, [latestQ.data])

  const onRefresh = () => { void cfgQ.refetch(); void latestQ.refetch() }

  if (cfgQ.isLoading) {
    return <ActivityIndicator testID="results-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (cfgQ.isError) {
    return <ErrorRetry onRetry={() => { void cfgQ.refetch() }}>Failed to load hosts.</ErrorRetry>
  }
  if (hosts.length === 0) return <Empty>No probing hosts — enable one in Hosts.</Empty>

  return (
    <View style={{ flex: 1 }}>
      <HostChips hosts={hosts} serverID={serverID} onPick={setPicked} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}
        refreshControl={
          <RefreshControl refreshing={cfgQ.isRefetching || latestQ.isRefetching} onRefresh={onRefresh} tintColor={t.primary} />
        }
      >
        {latestQ.isLoading ? (
          <ActivityIndicator testID="latest-loading" color={t.primary} style={{ marginTop: 24 }} />
        ) : latestQ.isError ? (
          <ErrorRetry onRetry={() => { void latestQ.refetch() }}>Failed to load samples.</ErrorRetry>
        ) : (latestQ.data ?? []).length === 0 ? (
          <Empty>No samples yet — wait one sample interval.</Empty>
        ) : (
          ISP_ORDER.map((isp) => {
            const rows = grouped.get(isp) ?? []
            if (rows.length === 0) return null
            return (
              <Card key={isp}>
                <CardHead>{ISP_LABEL[isp]}</CardHead>
                {rows.map((r) => <NetqualityRow key={String(r.target_id)} row={r} />)}
              </Card>
            )
          })
        )}
      </ScrollView>
    </View>
  )
}

// ── screen ────────────────────────────────────────────────────────────────────

export default function NetqualityScreen() {
  const router = useRouter()
  const t = useTheme()
  const [section, setSection] = useState<Section>('hosts')
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Network quality' }} />
      <NavBar title="Network quality" onBack={() => router.back()} backLabel="Plugin" />
      <View style={{ padding: 16, paddingBottom: 0, alignItems: 'center', backgroundColor: t.bg }}>
        <Segmented<Section>
          value={section}
          onChange={setSection}
          options={[
            { value: 'hosts', label: 'Hosts' },
            { value: 'targets', label: 'Targets' },
            { value: 'results', label: 'Results' },
          ]}
        />
      </View>
      {section === 'hosts' ? <HostsSection />
        : section === 'targets' ? <TargetsSection />
          : <ResultsSection />}
    </Screen>
  )
}
