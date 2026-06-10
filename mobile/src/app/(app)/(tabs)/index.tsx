import { memo, useCallback, useMemo, useState } from 'react'
import { SectionList, ScrollView, View, Text, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useServers, useServersLatest, type ServerRow } from '@/api/servers'
import { isOnline, memPct, firstDiskPct, nullStr } from '@/api/metrics'
import { bps, cmpStr } from '@/lib/format'
import { useWallLiveStore } from '@/api/wallLive'
import { LiveNet } from '@/components/LiveNet'
import {
  Header, Kpi, Card, MetricBar, Pill, OnlineDot, Cc, Icon, IconButton, Empty, Input, Segmented, statusOf,
} from '@/components/ds'
import { useTheme, useThemeMode } from '@/theme'

const aliasOf = (r: ServerRow) => nullStr(r.public_alias) || r.name
const alertingScore = (l: ServerRow['latest']) =>
  Math.max(l?.cpu_pct ?? 0, memPct(l) ?? 0, firstDiskPct(l?.disks_json) ?? 0)

type StatusFilter = 'all' | 'online' | 'warn' | 'offline'
// "warn" mirrors the Alerting KPI / statusOf warn threshold (any gauge ≥ 80).
const isWarnRow = (r: ServerRow) => isOnline(r) && alertingScore(r.latest) >= 80
const matchesStatus = (r: ServerRow, f: StatusFilter): boolean =>
  f === 'all' ? true
  : f === 'online' ? isOnline(r)
  : f === 'offline' ? !isOnline(r)
  : isWarnRow(r)

// Subscribes to the live store so only this strip re-renders on a frame.
function TrafficCard({ onlineRows }: { onlineRows: ServerRow[] }) {
  const t = useTheme()
  const live = useWallLiveStore((s) => s.live)
  const rx = onlineRows.reduce((a, r) => a + (live[r.id]?.rx_bps ?? r.latest?.net_rx_bps ?? 0), 0)
  const tx = onlineRows.reduce((a, r) => a + (live[r.id]?.tx_bps ?? r.latest?.net_tx_bps ?? 0), 0)
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 13, paddingHorizontal: 14 }}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="arrow-down" size={15} color={t.primary} />
          <Text style={{ fontFamily: t.mono(500), fontSize: 14, color: t.text }}>{bps(rx)}</Text>
          <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim }}>in</Text>
        </View>
        <View style={{ width: 1, alignSelf: 'stretch', marginHorizontal: 14, marginVertical: -2, backgroundColor: t.border }} />
        <View style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
          <Icon name="arrow-up" size={15} color={t.muted} />
          <Text style={{ fontFamily: t.mono(500), fontSize: 14, color: t.text }}>{bps(tx)}</Text>
          <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim }}>out</Text>
        </View>
      </View>
    </Card>
  )
}

// Memoized list row: re-renders only when its row reference changes (query
// refresh), not when the list re-renders. Live ↓/↑ traffic stays inside the
// LiveNet render-prop cell, so WS frames never touch the SectionList.
const HostCard = memo(function HostCard({ row, onOpen }: { row: ServerRow; onOpen: (id: number) => void }) {
  const t = useTheme()
  const online = isOnline(row)
  const l = row.latest
  const alias = aliasOf(row)
  const cc = nullStr(row.country_code)
  const os = nullStr(row.agent_os)
  const st = statusOf({
    online,
    cpu: l?.cpu_pct ?? 0,
    mem: memPct(l) ?? 0,
    disk: firstDiskPct(l?.disks_json) ?? 0,
  })
  return (
    <Pressable
      onPress={() => onOpen(row.id)}
      style={({ pressed }) => ({
        backgroundColor: t.surface, borderWidth: 1,
        borderColor: pressed ? t.borderStrong : t.border,
        borderRadius: t.radiusLg, padding: 14, opacity: online ? 1 : 0.6,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <OnlineDot online={online} />
        {cc ? <Cc code={cc} /> : null}
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.mono(500), fontSize: t.fs.md, color: t.text }}>{alias}</Text>
        {online ? <Pill kind={st.kind}>{st.label}</Pill> : null}
      </View>
      {online ? (
        <>
          {os || l?.load_1 != null ? (
            <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim, marginTop: 6 }}>
              {[os, l?.load_1 != null ? `load ${l.load_1.toFixed(2)}` : null].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          <View style={{ marginTop: 11, gap: 7 }}>
            <MetricBar label="CPU" value={l?.cpu_pct ?? null} />
            <MetricBar label="MEM" value={memPct(l)} />
            <MetricBar label="DSK" value={firstDiskPct(l?.disks_json)} />
          </View>
          <LiveNet id={row.id} fallbackRx={l?.net_rx_bps ?? 0} fallbackTx={l?.net_tx_bps ?? 0}>
            {(rx, tx) => (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 9 }}>
                <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.muted }}>↓ {bps(rx)}</Text>
                <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.muted }}>↑ {bps(tx)}</Text>
                {l?.tcp_conn != null ? (
                  <Text style={{ marginLeft: 'auto', fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>
                    {String(l.tcp_conn)} conns
                  </Text>
                ) : null}
              </View>
            )}
          </LiveNet>
        </>
      ) : (
        <Text style={{ fontFamily: t.mono(), fontSize: 10.5, color: t.fgDim, marginTop: 8 }}>agent offline</Text>
      )}
    </Pressable>
  )
})

type Section = { title: string; online: number; total: number; data: ServerRow[] }

// 8px between cards inside a group (was `gap: 8` on the group <View>).
const RowGap = () => <View style={{ height: 8 }} />

export default function Home() {
  const t = useTheme()
  const router = useRouter()
  const toggleTheme = useThemeMode((s) => s.toggle)
  const list = useServers()          // fast — paints the list immediately
  const latest = useServersLatest()  // metrics — fills the bars in after
  // Manual-only spinner: tied to this state, never isRefetching, so background
  // refetches don't flash the pull-to-refresh control.
  const [refreshing, setRefreshing] = useState(false)
  const onRefresh = async () => {
    setRefreshing(true)
    try { await Promise.all([list.refetch(), latest.refetch()]) } finally { setRefreshing(false) }
  }
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  // Merge: prefer the metric-enriched row once it arrives, else the plain row.
  const rows = useMemo(() => {
    const byId = new Map((latest.data ?? []).map((s) => [s.id, s]))
    return (list.data ?? []).map((s) => byId.get(s.id) ?? s)
  }, [list.data, latest.data])
  const total = rows.length
  const onlineRows = rows.filter(isOnline)
  const alerting = onlineRows.filter((r) => alertingScore(r.latest) >= 80).length
  const offline = total - onlineRows.length

  // Search first (name / alias / ssh host, case-insensitive includes), then the
  // status chip — chip counts are live against the searched set.
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) =>
      [r.name, nullStr(r.public_alias), nullStr(r.ssh_host)]
        .some((s) => s.toLowerCase().includes(q)))
  }, [rows, query])
  const counts = useMemo(() => ({
    all: searched.length,
    online: searched.filter(isOnline).length,
    warn: searched.filter(isWarnRow).length,
    offline: searched.filter((r) => !isOnline(r)).length,
  }), [searched])
  const filtered = useMemo(
    () => (statusFilter === 'all' ? searched : searched.filter((r) => matchesStatus(r, statusFilter))),
    [searched, statusFilter],
  )

  // Sections derive from the already-searched/filtered rows: group by
  // public_group (cmpStr — Hermes has no Intl, never localeCompare), rows
  // online-first then by alias.
  const sections = useMemo<Section[]>(() => {
    const groups = new Map<string, ServerRow[]>()
    for (const r of filtered) {
      const k = nullStr(r.public_group)
      const a = groups.get(k) ?? []
      a.push(r)
      groups.set(k, a)
    }
    return [...groups.entries()]
      .sort(([a], [b]) => cmpStr(a, b))
      .map(([title, ss]) => ({
        title,
        online: ss.filter(isOnline).length,
        total: ss.length,
        data: ss.slice().sort((a, b) => {
          const oa = isOnline(a) ? 0 : 1, ob = isOnline(b) ? 0 : 1
          return oa - ob || cmpStr(aliasOf(a), aliasOf(b))
        }),
      }))
  }, [filtered])

  const onOpen = useCallback((id: number) => router.push(`/(app)/server/${id}`), [router])
  const renderItem = useCallback(
    ({ item }: { item: ServerRow }) => <HostCard row={item} onOpen={onOpen} />,
    [onOpen],
  )
  const renderSectionHeader = useCallback(
    ({ section }: { section: Section }) => (
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, paddingHorizontal: 2, marginTop: 16, marginBottom: 8 }}>
        <Text style={{ fontFamily: t.mono(600), fontSize: 12.5, color: t.text }}>{section.title || 'Ungrouped'}</Text>
        <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.fgDim }}>{section.online}/{section.total} online</Text>
      </View>
    ),
    [t],
  )

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header
        title="Servers"
        sub="Fleet at a glance"
        actions={
          <>
            <IconButton name={t.mode === 'dark' ? 'sun' : 'moon'} size={19} onPress={() => { void toggleTheme() }} />
            <IconButton name="plus" size={20} accessibilityLabel="Add server" onPress={() => router.push('/(app)/server-new')} />
          </>
        }
      />
      {list.isLoading ? (
        <ActivityIndicator color={t.primary} style={{ marginTop: 32 }} />
      ) : list.isError ? (
        <Text style={{ color: t.error, padding: 16 }}>
          {list.error instanceof Error ? list.error.message : 'failed to load'}
        </Text>
      ) : (
        <SectionList<ServerRow, Section>
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 16, paddingBottom: 92 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.primary} />}
          sections={sections}
          keyExtractor={(r) => String(r.id)}
          renderItem={renderItem}
          renderSectionHeader={renderSectionHeader}
          ItemSeparatorComponent={RowGap}
          stickySectionHeadersEnabled={false}
          initialNumToRender={30}
          ListHeaderComponent={
            <View style={{ gap: 16 }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
                <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Nodes" value={total} /></View>
                <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Online" value={onlineRows.length} tone="ok" /></View>
                <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Offline" value={offline} tone={offline > 0 ? 'err' : undefined} /></View>
                <View style={{ flexGrow: 1, flexBasis: '46%' }}><Kpi label="Alerting" value={alerting} tone={alerting > 0 ? 'warn' : undefined} /></View>
              </View>

              <TrafficCard onlineRows={onlineRows} />

              <View style={{ gap: 10 }}>
                <View style={{ justifyContent: 'center' }}>
                  <Input
                    value={query}
                    onChangeText={setQuery}
                    placeholder="Search name, alias, or host"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    accessibilityLabel="Search servers"
                    style={{ height: 38, fontSize: t.fs.sm, paddingRight: 38 }}
                  />
                  {query !== '' ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Clear search"
                      onPress={() => setQuery('')}
                      style={{ position: 'absolute', right: 0, width: 38, height: 38, alignItems: 'center', justifyContent: 'center' }}
                    >
                      <Icon name="x" size={15} color={t.muted} />
                    </Pressable>
                  ) : null}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16 }}>
                  <Segmented<StatusFilter>
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { value: 'all', label: `All ${counts.all}` },
                      { value: 'online', label: `Online ${counts.online}` },
                      { value: 'warn', label: `Warn ${counts.warn}` },
                      { value: 'offline', label: `Offline ${counts.offline}` },
                    ]}
                  />
                </ScrollView>
              </View>
            </View>
          }
          ListEmptyComponent={
            <View style={{ marginTop: 16 }}>
              <Empty>{total === 0 ? 'No servers.' : 'No matches.'}</Empty>
            </View>
          }
        />
      )}
    </View>
  )
}
