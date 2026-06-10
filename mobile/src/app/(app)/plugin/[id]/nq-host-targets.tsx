import { useMemo, useState } from 'react'
import { View, Text, ScrollView, ActivityIndicator, RefreshControl } from 'react-native'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import {
  useNetqualityHostTargets, updateNetqualityHostTargets,
  type NetqualityISP, type NetqualityHostTarget,
} from '@/api/netquality'
import { cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Card, CardHead, Switch, Button, Empty, ErrLine } from '@/components/ds'

const ISP_ORDER: NetqualityISP[] = ['telecom', 'unicom', 'mobile', 'overseas']
const ISP_LABEL: Record<NetqualityISP, string> = {
  telecom: '电信',
  unicom: '联通',
  mobile: '移动',
  overseas: '海外',
}

// initialSelection derives the seed Set of selected target ids from the query
// data — a pure derive, NOT setState-in-effect (eslint forbids the effect form).
export function initialSelection(rows: readonly NetqualityHostTarget[]): Set<number> {
  return new Set(rows.filter((r) => r.selected).map((r) => r.target_id))
}

function TargetPicker({ serverID }: { serverID: number }) {
  const t = useTheme()
  const router = useRouter()
  const q = useNetqualityHostTargets(serverID)
  // Local edit buffer. Seeded lazily from query data on the render where it first
  // resolves (a derive guarded by a "did we seed yet" ref-like flag in state),
  // never via an effect.
  const [seededFor, setSeededFor] = useState<readonly NetqualityHostTarget[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Derive the seed once per distinct query result object. Calling setState here
  // during render (not in an effect) is the React-sanctioned reseed pattern and
  // satisfies the no-setState-in-effect rule.
  if (q.data && q.data !== seededFor) {
    setSeededFor(q.data)
    setSelected(initialSelection(q.data))
  }

  const grouped = useMemo(() => {
    const m = new Map<NetqualityISP, NetqualityHostTarget[]>()
    for (const r of q.data ?? []) {
      const arr = m.get(r.isp) ?? []
      arr.push(r)
      m.set(r.isp, arr)
    }
    for (const arr of m.values()) arr.sort((a, b) => cmpStr(a.label, b.label))
    return m
  }, [q.data])

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const save = async () => {
    setBusy(true); setError(null)
    try {
      await updateNetqualityHostTargets(serverID, [...selected])
      router.back()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save failed')
    } finally {
      setBusy(false)
    }
  }

  if (q.isLoading) {
    return <ActivityIndicator testID="picker-loading" color={t.primary} style={{ marginTop: 32 }} />
  }
  if (q.isError) {
    return (
      <View style={{ alignItems: 'center', gap: 12, padding: 24 }}>
        <ErrLine>Failed to load targets.</ErrLine>
        <Button variant="outline" icon="refresh-cw" onPress={() => { void q.refetch() }}>Retry</Button>
      </View>
    )
  }
  if ((q.data ?? []).length === 0) {
    return <Empty>No enabled targets — add some in the Targets tab.</Empty>
  }

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 16, paddingBottom: 24, gap: 16 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={t.primary} />}
      >
        {ISP_ORDER.map((isp) => {
          const rows = grouped.get(isp) ?? []
          if (rows.length === 0) return null
          return (
            <Card key={isp}>
              <CardHead>{ISP_LABEL[isp]}</CardHead>
              {rows.map((r) => (
                <View
                  key={String(r.target_id)}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 8,
                    paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderTopColor: t.border,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontFamily: t.font(500), fontSize: t.fs.sm, color: t.text }}>
                      {r.label}
                    </Text>
                    <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: t.fs.xs, color: t.muted, marginTop: 2 }}>
                      {r.region}{r.region ? ' · ' : ''}{r.host}
                    </Text>
                  </View>
                  <Switch
                    testID={`pick-${r.target_id}`}
                    on={selected.has(r.target_id)}
                    onChange={() => toggle(r.target_id)}
                  />
                </View>
              ))}
            </Card>
          )
        })}
        {error ? <ErrLine>{error}</ErrLine> : null}
      </ScrollView>
      <View style={{ padding: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.border, gap: 8, backgroundColor: t.surface }}>
        <Text style={{ fontFamily: t.mono(), fontSize: 11.5, color: t.fgDim, textAlign: 'center' }}>
          {selected.size} selected
        </Text>
        <Button testID="picker-save" variant="primary" block disabled={busy} onPress={save}>Save</Button>
      </View>
    </View>
  )
}

export default function NetqualityHostTargetsScreen() {
  const router = useRouter()
  const { serverId } = useLocalSearchParams<{ id: string; serverId?: string }>()
  const sid = Number(serverId)
  const valid = serverId != null && serverId !== 'undefined' && Number.isFinite(sid)
  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Host targets' }} />
      <NavBar title="Host targets" onBack={() => router.back()} backLabel="Network quality" />
      {valid ? (
        <TargetPicker serverID={sid} />
      ) : (
        <Empty>No server selected.</Empty>
      )}
    </Screen>
  )
}
