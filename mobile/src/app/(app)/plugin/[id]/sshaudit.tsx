import { useMemo, useState } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, RefreshControl, Alert } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import {
  useSshauditHosts, useSshauditSessions, useSshauditEvents, useSshauditSummary,
  useSshauditFail2ban, setSshauditFail2ban, collectSshaudit,
  type SshauditHost, type SshauditEventFilter, type SshauditWindow, type SshauditEvent,
} from '@/api/sshaudit'
import { useServers, type ServerRow } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { cmpStr, relTime } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, CardHead, Pill, Segmented, Switch, Button, Empty } from '@/components/ds'

type Tab = 'sessions' | 'history' | 'hardening'

// Result filter options for the History tab (mirrors the GET /events ?result).
const RESULT_FILTERS: { value: SshauditEventFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'accepted', label: 'Accepted' },
  { value: 'failed', label: 'Failed' },
]

// Time-window options for the History tab (drives both summary + events).
const WINDOWS: { value: SshauditWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
]

// ── pure helpers (exported for tests) ────────────────────────────────────────

// serverLabel resolves a server's display name through the servers join.
// public_alias is a Go sql.NullString → must go through nullStr().
function serverLabel(servers: ServerRow[], sid: number): string {
  const s = servers.find((x) => x.id === sid)
  return s ? (nullStr(s.public_alias) || s.name || `#${sid}`) : `#${sid}`
}

// humanSeconds renders a duration in seconds as a compact label (600→"10m",
// 3600→"1h", 86400→"24h"), falling back to "{n}s". Pure, no Intl/toLocaleString.
function humanSeconds(n: number): string {
  if (n <= 0) return `${n}s`
  if (n % 3600 === 0) return `${n / 3600}h`
  if (n % 60 === 0) return `${n / 60}m`
  return `${n}s`
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

// Host picker chips — same pattern as netquality; here over the configured
// sshaudit hosts (server_id is the stable key).
function HostChips({ hosts, serverID, onPick }: {
  hosts: { server_id: number; accepted_24h: number; failed_24h: number }[]
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
              minHeight: 30, paddingHorizontal: 12, paddingVertical: 4, borderRadius: t.radius, justifyContent: 'center',
              backgroundColor: active ? t.sunken : 'transparent',
              borderWidth: 1, borderColor: active ? t.borderStrong : t.border,
            }}
          >
            <Text style={{ fontFamily: t.mono(active ? 500 : 400), fontSize: 12, color: active ? t.text : t.muted }}>
              {serverLabel(servers, h.server_id)}
            </Text>
            {/* Compact 24h login tally — accepted in ok color, failed in err. */}
            <Text testID={`host-tally-${h.server_id}`} style={{ fontFamily: t.mono(), fontSize: 10, marginTop: 1 }}>
              <Text style={{ color: t.ok }}>{`✓${String(h.accepted_24h)}`}</Text>
              <Text style={{ color: t.muted }}>{' '}</Text>
              <Text style={{ color: t.err }}>{`✗${String(h.failed_24h)}`}</Text>
            </Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

// ── Sessions tab (current SSH situation) ────────────────────────────────────────

function SessionsTab({ serverID }: { serverID: number }) {
  const t = useTheme()
  const q = useSshauditSessions(serverID)
  const [collecting, setCollecting] = useState(false)

  const onCollect = async () => {
    if (collecting) return
    setCollecting(true)
    try {
      const r = await collectSshaudit(serverID)
      await q.refetch()
      Alert.alert('Collected', `${r.inserted} new event${r.inserted === 1 ? '' : 's'} recorded.`)
    } catch (e) {
      Alert.alert('Collect failed', e instanceof Error ? e.message : 'request failed')
    } finally {
      setCollecting(false)
    }
  }

  if (q.isLoading) {
    return <ActivityIndicator testID="sessions-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  // A 502 from an offline host surfaces as isError — render a graceful retry.
  if (q.isError) {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
      >
        <ErrorRetry onRetry={() => { void q.refetch() }}>
          {'Host offline — could not read live sessions.'}
        </ErrorRetry>
      </ScrollView>
    )
  }

  const sessions = q.data?.sessions ?? []

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 12 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={{ flex: 1, fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim }}>
          {sessions.length} active · collected {q.data?.collected_at ? relTime(q.data.collected_at) : '—'}
        </Text>
        <Button
          testID="collect-now"
          variant="outline"
          icon="refresh-cw"
          disabled={collecting}
          onPress={onCollect}
        >
          {collecting ? 'Collecting…' : 'Collect now'}
        </Button>
      </View>
      {sessions.length === 0 ? (
        <Empty>No active SSH sessions.</Empty>
      ) : (
        <Card>
          {sessions.map((s, i) => (
            <View
              key={`${s.tty}-${String(s.pid ?? i)}`}
              testID={`session-${i}`}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                paddingHorizontal: 14, paddingVertical: 10,
                borderTopWidth: i > 0 ? 1 : 0, borderTopColor: t.border,
              }}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.font(500), fontSize: t.fs.sm, color: t.text }}>
                    {s.user}
                  </Text>
                  <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
                    {s.tty}
                  </Text>
                </View>
                <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted, marginTop: 2 }}>
                  {s.source_ip}{s.pid != null ? ` · pid ${s.pid}` : ''}
                </Text>
              </View>
              <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim }}>{relTime(s.login_at)}</Text>
            </View>
          ))}
        </Card>
      )}
    </ScrollView>
  )
}

// ── History tab (login success/failure) ──────────────────────────────────────

function SummaryStrip({ serverID, window }: { serverID: number; window: SshauditWindow }) {
  const t = useTheme()
  const q = useSshauditSummary(serverID, window)
  const s = q.data
  if (!s) return null
  const topSource = s.top_sources[0]
  const topFailed = s.top_failed_users[0]
  return (
    <Card style={{ padding: 14, gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text style={{ flex: 1, fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>
          {`Last ${s.window_hours}h`}
        </Text>
        <Text style={{ fontFamily: t.mono(), fontSize: 10, color: t.fgDim }}>
          summary reflects window
        </Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
        <Pill kind="ok">{`${s.accepted} accepted`}</Pill>
        <Pill kind={s.failed > 0 ? 'err' : 'neutral'}>{`${s.failed} failed`}</Pill>
        <Pill kind="neutral">{`${s.unique_source_ips} IPs`}</Pill>
      </View>
      {topSource ? (
        <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          {`top source ${topSource.source_ip} (${topSource.count})`}
        </Text>
      ) : null}
      {topFailed ? (
        <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
          {`top failed user ${topFailed.username} (${topFailed.count})`}
        </Text>
      ) : null}
    </Card>
  )
}

function EventRow({ ev, index }: { ev: SshauditEvent; index: number }) {
  const t = useTheme()
  return (
    <View
      testID={`event-${ev.id}`}
      style={{
        flexDirection: 'row', alignItems: 'flex-start', gap: 8,
        paddingHorizontal: 14, paddingVertical: 10,
        borderTopWidth: index > 0 ? 1 : 0, borderTopColor: t.border,
      }}
    >
      <Pill kind={ev.result === 'accepted' ? 'ok' : 'err'}>{ev.result}</Pill>
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.font(500), fontSize: t.fs.sm, color: t.text }}>
            {ev.username || '—'}
          </Text>
          {ev.invalid_user ? (
            <Text testID={`event-invalid-${ev.id}`} style={{
              fontFamily: t.mono(500), fontSize: 10, color: t.warn,
              borderWidth: 1, borderColor: t.warn, borderRadius: t.radiusPill,
              paddingHorizontal: 6, paddingVertical: 1,
            }}>
              invalid
            </Text>
          ) : null}
        </View>
        <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted, marginTop: 2 }}>
          {ev.source_ip}{ev.port != null ? `:${ev.port}` : ''} · {ev.method}
        </Text>
      </View>
      <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.fgDim }}>{relTime(ev.ts)}</Text>
    </View>
  )
}

function HistoryTab({ serverID }: { serverID: number }) {
  const t = useTheme()
  const [filter, setFilter] = useState<SshauditEventFilter>('all')
  const [window, setWindow] = useState<SshauditWindow>('24h')
  const summaryQ = useSshauditSummary(serverID, window)
  const eventsQ = useSshauditEvents(serverID, filter, window)

  const onRefresh = () => { void summaryQ.refetch(); void eventsQ.refetch() }

  const events = eventsQ.data ?? []

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 14 }}
      refreshControl={
        <RefreshControl refreshing={summaryQ.isRefetching || eventsQ.isRefetching} onRefresh={onRefresh} tintColor={t.primary} />
      }
    >
      <SummaryStrip serverID={serverID} window={window} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Segmented<SshauditWindow> value={window} onChange={setWindow} options={WINDOWS} />
        <Segmented<SshauditEventFilter> value={filter} onChange={setFilter} options={RESULT_FILTERS} />
      </View>
      {eventsQ.isLoading ? (
        <ActivityIndicator testID="events-loading" color={t.primary} style={{ marginTop: 24 }} />
      ) : eventsQ.isError ? (
        <ErrorRetry onRetry={() => { void eventsQ.refetch() }}>Failed to load login history.</ErrorRetry>
      ) : events.length === 0 ? (
        <Empty>No login events recorded.</Empty>
      ) : (
        <Card>
          <CardHead>{`${events.length} event${events.length === 1 ? '' : 's'}`}</CardHead>
          {events.map((ev, i) => (
            <EventRow key={String(ev.id)} ev={ev} index={i} />
          ))}
        </Card>
      )}
    </ScrollView>
  )
}

// ── Hardening tab (fail2ban per host) ────────────────────────────────────────

// A labelled numeric stat cell for the fail2ban status card.
function Stat({ label, value, tone }: { label: string; value: number; tone?: 'err' }) {
  const t = useTheme()
  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text style={{ fontFamily: t.mono(600), fontSize: 18, color: tone === 'err' && value > 0 ? t.err : t.text }}>
        {String(value)}
      </Text>
      <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>{label}</Text>
    </View>
  )
}

function HardeningTab({ serverID }: { serverID: number }) {
  const t = useTheme()
  const q = useSshauditFail2ban(serverID)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const s = q.data

  // The toggle: enabling installs a package + starts the service, so confirm
  // first; disabling is immediate. Both can be slow → a busy state.
  const apply = async (enabled: boolean) => {
    if (busy) return
    setBusy(true)
    setErr(null)
    try {
      await setSshauditFail2ban(serverID, enabled)
      await q.refetch()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'request failed')
    } finally {
      setBusy(false)
    }
  }

  const onToggle = (next: boolean) => {
    if (busy) return
    if (next) {
      Alert.alert(
        'Enable fail2ban?',
        'This installs the fail2ban package and starts the service on this host. It may take a moment.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Enable', onPress: () => { void apply(true) } },
        ],
      )
    } else {
      void apply(false)
    }
  }

  if (q.isLoading) {
    return <ActivityIndicator testID="fail2ban-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  // A 502 from an offline host surfaces as isError — graceful retry/offline.
  if (q.isError) {
    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
      >
        <ErrorRetry onRetry={() => { void q.refetch() }}>
          {'Host offline — could not read fail2ban status.'}
        </ErrorRetry>
      </ScrollView>
    )
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 14 }}
      refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
    >
      {s == null ? null : !s.installed ? (
        // Not installed → a clear call-to-action to enable hardening.
        <Card style={{ padding: 16, gap: 12, alignItems: 'flex-start' }}>
          <Text style={{ fontFamily: t.font(500), fontSize: t.fs.md, color: t.text }}>
            fail2ban is not installed
          </Text>
          <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.muted }}>
            Enable hardening to install fail2ban and automatically ban IPs after repeated failed SSH logins.
          </Text>
          {err ? (
            <Text testID="fail2ban-error" style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.err }}>{err}</Text>
          ) : null}
          <Button testID="fail2ban-enable" icon="shield" disabled={busy} onPress={() => onToggle(true)}>
            {busy ? 'Installing…' : 'Enable hardening'}
          </Button>
        </Card>
      ) : (
        <>
          <Card style={{ padding: 14, gap: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>fail2ban</Text>
                <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>
                  {busy ? 'Installing…' : s.active ? 'active — banning brute-force IPs' : 'installed, stopped'}
                </Text>
              </View>
              {s.active ? <Pill kind="ok">active</Pill> : <Pill kind="neutral">stopped</Pill>}
              <Switch testID="fail2ban-switch" on={s.active} disabled={busy} onChange={onToggle} />
            </View>
            {err ? (
              <Text testID="fail2ban-error" style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.err }}>{err}</Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Stat label="currently banned" value={s.currently_banned} tone="err" />
              <Stat label="total banned" value={s.total_banned} />
            </View>
            {s.max_retry > 0 && s.find_time > 0 && s.ban_time > 0 ? (
              <View
                testID="fail2ban-policy"
                style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: 10, gap: 2 }}
              >
                <Text style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted }}>Ban policy</Text>
                <Text style={{ fontFamily: t.mono(), fontSize: t.fs.sm, color: t.text }}>
                  {`${s.max_retry} failed attempts within ${humanSeconds(s.find_time)} → ban for ${humanSeconds(s.ban_time)}`}
                </Text>
              </View>
            ) : null}
          </Card>
          {s.banned_ips.length > 0 ? (
            <Card>
              <CardHead>{`Banned IPs · ${s.banned_ips.length}`}</CardHead>
              {s.banned_ips.map((ip, i) => (
                <View
                  key={ip}
                  testID={`banned-${i}`}
                  style={{
                    paddingHorizontal: 14, paddingVertical: 9,
                    borderTopWidth: i > 0 ? 1 : 0, borderTopColor: t.border,
                  }}
                >
                  <Text style={{ fontFamily: t.mono(), fontSize: t.fs.sm, color: t.text }}>{ip}</Text>
                </View>
              ))}
            </Card>
          ) : (
            <Empty>No IPs currently banned.</Empty>
          )}
        </>
      )}
    </ScrollView>
  )
}

// ── tab body (host-aware) ──────────────────────────────────────────────────────

function TabBody({ tab, hosts }: { tab: Tab; hosts: SshauditHost[] }) {
  const [picked, setPicked] = useState<number | null>(null)
  // Default to the first configured host — derived, no effect.
  const serverID = picked ?? hosts[0]?.server_id ?? null

  if (serverID == null) {
    return <Empty>No SSH audit hosts — enable collection on a server first.</Empty>
  }

  return (
    <View style={{ flex: 1 }}>
      <HostChips hosts={hosts} serverID={serverID} onPick={setPicked} />
      {tab === 'sessions' ? (
        <SessionsTab key={serverID} serverID={serverID} />
      ) : tab === 'history' ? (
        <HistoryTab key={serverID} serverID={serverID} />
      ) : (
        <HardeningTab key={serverID} serverID={serverID} />
      )}
    </View>
  )
}

// ── screen ────────────────────────────────────────────────────────────────────

export default function SshauditScreen() {
  const router = useRouter()
  const t = useTheme()
  const [tab, setTab] = useState<Tab>('sessions')
  const hostsQ = useSshauditHosts()

  const hosts = useMemo(() => {
    const list = [...(hostsQ.data ?? [])]
    list.sort((a, b) => cmpStr(String(a.server_id), String(b.server_id)))
    return list
  }, [hostsQ.data])

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'SSH Audit' }} />
      <NavBar title="SSH Audit" onBack={() => router.back()} backLabel="Plugin" />
      <View style={{ padding: 16, paddingBottom: 0, alignItems: 'center', backgroundColor: t.bg }}>
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: 'sessions', label: 'Sessions' },
            { value: 'history', label: 'History' },
            { value: 'hardening', label: 'Hardening' },
          ]}
        />
      </View>
      {hostsQ.isLoading ? (
        <ActivityIndicator testID="hosts-loading" color={t.primary} style={{ marginTop: 32 }} />
      ) : hostsQ.isError ? (
        <ErrorRetry onRetry={() => { void hostsQ.refetch() }}>Failed to load SSH audit hosts.</ErrorRetry>
      ) : (
        <TabBody tab={tab} hosts={hosts} />
      )}
    </Screen>
  )
}
