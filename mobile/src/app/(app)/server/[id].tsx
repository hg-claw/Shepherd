import React, { useEffect, useRef, useState } from 'react'
import { ScrollView, View, Text, ActivityIndicator, Alert } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { useServersLatest, useHostTraffic, updateAgent, repairServer, deleteServer } from '@/api/servers'
import { APIError } from '@/api/client'
import { isOnline, memPct, firstDiskPct, nullStr, useTelemetrySeries, type TelemetryRange } from '@/api/metrics'
import { bps, bytes, pct, relTime } from '@/lib/format'
import { LiveNet } from '@/components/LiveNet'
import {
  NavBar, IconButton, Pill, Card, CardHead, Button, ListRow, Cc, Empty, Kpi, statusOf, barKind,
  Segmented, AreaChart,
} from '@/components/ds'
import { useTheme } from '@/theme'

// expo-clipboard is a NATIVE module. Load it guardedly so a JS-only update on an
// older dev client (one built before this dep was added) doesn't crash the
// screen — Copy just disappears until the client is rebuilt.
let clipboardSet: ((s: string) => Promise<unknown>) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  clipboardSet = require('expo-clipboard').setStringAsync
} catch {
  clipboardSet = null
}

const EM_DASH = '—'

// Hermes-safe local timestamp (no Intl/toLocaleString).
function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// One line in the details Card: dim label left, mono value right. `first` drops
// the top divider so it doesn't double up with the Card border.
function Row({ label, value, first }: { label: string; value: React.ReactNode; first?: boolean }) {
  const t = useTheme()
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      paddingVertical: 11, paddingHorizontal: 14,
      borderTopWidth: first ? 0 : 1, borderTopColor: t.border,
    }}>
      <Text style={{ fontFamily: t.font(), fontSize: 13, color: t.muted }}>{label}</Text>
      <Text style={{ fontFamily: t.mono(), fontSize: 13, color: t.text }}>{value}</Text>
    </View>
  )
}

const RANGES: { value: TelemetryRange; label: string }[] = [
  { value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' },
]

// One labelled chart inside the History card: mono label left, sparkline below.
function ChartBlock({ label, values, color, format }: {
  label: string; values: (number | null)[]; color?: string; format?: (v: number) => string
}) {
  const t = useTheme()
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontFamily: t.mono(), fontSize: 10, letterSpacing: 0.4, color: t.muted }}>{label}</Text>
      <AreaChart data={values} height={56} color={color} format={format} />
    </View>
  )
}

// History: telemetry charts (CPU / MEM / NET) with a 1h/24h/7d range selector.
function History({ id }: { id: number }) {
  const t = useTheme()
  const [range, setRange] = useState<TelemetryRange>('1h')
  const q = useTelemetrySeries(id, range)
  const pts = q.data ?? []
  const fmtPct = (v: number) => pct(v)
  return (
    <Card>
      <CardHead>
        <Text style={{ flex: 1, fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>History</Text>
        <Segmented value={range} onChange={setRange} options={RANGES} />
      </CardHead>
      <View style={{ padding: 14, gap: 14 }}>
        {q.isLoading ? (
          <ActivityIndicator color={t.primary} style={{ marginVertical: 40 }} />
        ) : (
          <>
            <ChartBlock label="CPU %" values={pts.map((p) => p.cpu_pct ?? null)} format={fmtPct} />
            <ChartBlock label="MEM %" values={pts.map((p) => memPct(p))} color={t.ok} format={fmtPct} />
            <ChartBlock label="NET ↓ RX" values={pts.map((p) => p.net_rx_bps ?? null)} format={bps} />
            <ChartBlock label="NET ↑ TX" values={pts.map((p) => p.net_tx_bps ?? null)} color={t.warn} format={bps} />
          </>
        )}
      </View>
    </Card>
  )
}

// Traffic: current billing-cycle counters (read-only — reset-day editing and
// manual reset stay on web this round).
function Traffic({ id }: { id: number }) {
  const t = useTheme()
  const q = useHostTraffic(id)
  const d = q.data
  return (
    <Card>
      <CardHead>Traffic</CardHead>
      {q.isLoading ? (
        <ActivityIndicator color={t.primary} style={{ marginVertical: 24 }} />
      ) : !d ? (
        <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.muted, padding: 14 }}>
          {q.isError ? 'failed to load traffic' : 'no traffic data'}
        </Text>
      ) : (
        <View>
          <Row first label="This cycle" value={`↑ ${bytes(d.cum_bytes_up)}  ↓ ${bytes(d.cum_bytes_down)}`} />
          <Row
            label="Previous cycle"
            value={
              <Text style={{ fontFamily: t.mono(), fontSize: 12, color: t.muted }}>
                {`↑ ${bytes(d.prev_bytes_up)}  ↓ ${bytes(d.prev_bytes_down)}`}
              </Text>
            }
          />
          <Text style={{ fontFamily: t.font(), fontSize: 11.5, color: t.muted, paddingHorizontal: 14, paddingBottom: 12 }}>
            resets day {d.reset_day}{d.last_reset_at ? ` · last reset ${relTime(d.last_reset_at)}` : ''}
          </Text>
        </View>
      )}
    </Card>
  )
}

type ActionKey = 'update' | 'repair' | 'delete'

// Actions: per-host admin operations. Each action keeps its own busy flag and
// inline error (same pattern as plugin/[id]/hosts.tsx); confirms via Alert.
function Actions({ id, name }: { id: number; name: string }) {
  const t = useTheme()
  const router = useRouter()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<ActionKey | null>(null)
  const [errors, setErrors] = useState<Partial<Record<ActionKey, string>>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [repairToken, setRepairToken] = useState<{ token: string; expires: string } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

  const flashNotice = (msg: string) => {
    setNotice(msg)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 4000)
  }

  const run = async (action: ActionKey, fn: () => Promise<void>) => {
    if (busy) return
    setBusy(action)
    setErrors((prev) => ({ ...prev, [action]: '' }))
    try {
      await fn()
    } catch (e) {
      const msg = e instanceof APIError && e.status === 409
        ? 'agent offline — bring it online first'
        : e instanceof Error ? e.message : `${action} failed`
      setErrors((prev) => ({ ...prev, [action]: msg }))
    } finally {
      setBusy(null)
    }
  }

  const confirmUpdate = () => {
    Alert.alert('Update agent?', `Push an agent self-update to ${name}.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Update',
        onPress: () => { void run('update', async () => { await updateAgent(id); flashNotice('agent update started') }) },
      },
      {
        text: 'Update (CN mirror)',
        onPress: () => { void run('update', async () => { await updateAgent(id, true); flashNotice('agent update started (CN mirror)') }) },
      },
    ])
  }

  const confirmRepair = () => {
    Alert.alert('Repair enrollment?', 'Issues a short-lived token to re-enroll the agent on this host.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Repair',
        onPress: () => {
          void run('repair', async () => {
            const out = await repairServer(id)
            setRepairToken({ token: out.enrollment_token, expires: out.expires_at })
          })
        },
      },
    ])
  }

  const confirmDelete = () => {
    Alert.alert(`Delete ${name}?`, 'Removes this server and its data from Shepherd.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void run('delete', async () => {
            await deleteServer(id)
            await qc.invalidateQueries({ queryKey: ['servers'] })
            router.back()
          })
        },
      },
    ])
  }

  const spinner = (k: ActionKey) =>
    busy === k ? <ActivityIndicator size="small" color={t.primary} testID={`busy-${k}`} /> : null
  const errLine = (k: ActionKey) =>
    errors[k] ? (
      <Text testID={`action-error-${k}`} style={{ fontFamily: t.mono(), fontSize: 12, color: t.err, paddingHorizontal: 14, paddingBottom: 10 }}>
        {errors[k]}
      </Text>
    ) : null
  const divider = { borderTopWidth: 1, borderTopColor: t.border }

  return (
    <Card>
      <CardHead>Actions</CardHead>
      <ListRow
        icon="refresh-cw"
        title="Update agent"
        sub="self-update via control channel"
        chevron={false}
        onPress={busy ? undefined : confirmUpdate}
        right={spinner('update')}
      />
      {notice ? (
        <Text testID="action-notice" style={{ fontFamily: t.mono(), fontSize: 12, color: t.ok, paddingHorizontal: 14, paddingBottom: 10 }}>
          {notice}
        </Text>
      ) : null}
      {errLine('update')}
      <View style={divider}>
        <ListRow
          icon="shield"
          title="Repair enrollment"
          sub="issue a re-enrollment token"
          chevron={false}
          onPress={busy ? undefined : confirmRepair}
          right={spinner('repair')}
        />
      </View>
      {errLine('repair')}
      {repairToken ? (
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, gap: 8 }}>
          <Text
            selectable
            testID="repair-token"
            style={{
              fontFamily: t.mono(), fontSize: 12, color: t.text,
              backgroundColor: t.sunken, borderRadius: t.radius, padding: 10,
            }}
          >
            {repairToken.token}
          </Text>
          <Text style={{ fontFamily: t.font(), fontSize: 11.5, color: t.muted }}>
            expires {fmtTime(repairToken.expires)}
          </Text>
          {clipboardSet ? (
            <Button
              testID="copy-token"
              variant="outline"
              icon="copy"
              onPress={() => { void clipboardSet?.(repairToken.token); flashNotice('token copied') }}
            >
              Copy
            </Button>
          ) : null}
        </View>
      ) : null}
      <View style={divider}>
        <ListRow
          icon="x"
          iconColor={t.err}
          title="Delete server"
          titleColor={t.err}
          sub="remove this host from Shepherd"
          chevron={false}
          onPress={busy ? undefined : confirmDelete}
          right={spinner('delete')}
        />
      </View>
      {errLine('delete')}
    </Card>
  )
}

export default function ServerDetail() {
  const t = useTheme()
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const latest = useServersLatest()
  const row = latest.data?.find((s) => s.id === Number(id))

  if (!row && latest.isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar backLabel="Servers" onBack={() => router.back()} />
        <ActivityIndicator color={t.primary} style={{ marginTop: 32 }} />
      </View>
    )
  }
  if (!row) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <NavBar title="Not found" backLabel="Servers" onBack={() => router.back()} />
        <Empty>Host #{String(id)} not found.</Empty>
      </View>
    )
  }

  const l = row.latest
  const online = isOnline(row)
  const alias = nullStr(row.public_alias) || row.name
  const group = nullStr(row.public_group)
  const cc = nullStr(row.country_code)
  const kernel = nullStr(row.agent_kernel)
  const st = statusOf({
    online,
    cpu: l?.cpu_pct ?? 0,
    mem: memPct(l) ?? 0,
    disk: firstDiskPct(l?.disks_json) ?? 0,
  })
  const lastSeen = typeof row.agent_last_seen === 'object' && row.agent_last_seen?.Valid
    ? row.agent_last_seen.Time
    : null
  const load = l?.load_1 != null ? l.load_1.toFixed(2) : EM_DASH

  const openConsole = () => router.push(`/(app)/console/${row.id}`)

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <NavBar
        title={alias}
        backLabel="Servers"
        onBack={() => router.back()}
        actions={<IconButton name="square-terminal" size={20} onPress={openConsole} />}
      />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: 44, gap: 16 }}>
        <View style={{ gap: 9 }}>
          <Text
            numberOfLines={1}
            style={{ fontFamily: t.mono(600), fontSize: 23, letterSpacing: -0.23, color: t.text }}
          >
            {row.name}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <Pill kind={st.kind}>{st.label}</Pill>
            {group ? <Pill kind="neutral">{group}</Pill> : null}
            {cc ? <Pill kind="neutral"><Cc code={cc} /></Pill> : null}
          </View>
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="CPU" value={online ? pct(l?.cpu_pct ?? null) : EM_DASH} tone={barKind(l?.cpu_pct) || undefined} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="Memory" value={online ? pct(memPct(l)) : EM_DASH} tone={barKind(memPct(l)) || undefined} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="Disk" value={online ? pct(firstDiskPct(l?.disks_json)) : EM_DASH} tone={barKind(firstDiskPct(l?.disks_json)) || undefined} />
          </View>
          <View style={{ flexGrow: 1, flexBasis: '46%' }}>
            <Kpi label="Load 1m" value={online ? load : EM_DASH} />
          </View>
        </View>

        <Card>
          <LiveNet id={Number(id)} fallbackRx={l?.net_rx_bps ?? 0} fallbackTx={l?.net_tx_bps ?? 0}>
            {(rx, tx) => <Row first label="Net" value={online ? `↓ ${bps(rx)}  ↑ ${bps(tx)}` : EM_DASH} />}
          </LiveNet>
          <Row label="TCP conns" value={online && l?.tcp_conn != null ? String(l.tcp_conn) : EM_DASH} />
          <Row label="OS / Arch" value={`${nullStr(row.agent_os) || EM_DASH} / ${nullStr(row.agent_arch) || EM_DASH}`} />
          <Row label="Kernel" value={kernel || EM_DASH} />
          <Row label="Last seen" value={lastSeen ? relTime(lastSeen) : EM_DASH} />
        </Card>

        <History id={row.id} />

        <Traffic id={row.id} />

        <View style={{ gap: 12 }}>
          <Button variant="primary" block icon="square-terminal" onPress={openConsole}>Open console</Button>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Button variant="outline" block icon="folder-tree" onPress={() => router.push(`/(app)/files/${row.id}`)}>Files</Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button variant="outline" block icon="play" onPress={() => router.push(`/(app)/scripts?serverId=${row.id}`)}>Run script</Button>
            </View>
          </View>
        </View>

        <Actions id={row.id} name={alias} />
      </ScrollView>
    </View>
  )
}
