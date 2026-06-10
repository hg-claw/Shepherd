import { useMemo, useState } from 'react'
import { View, Text, FlatList, ScrollView, Pressable, ActivityIndicator, RefreshControl } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { useAuditLog, type AuditRow } from '@/api/audit'
import { useServers } from '@/api/servers'
import { nullStr } from '@/api/metrics'
import { relTime, cmpStr } from '@/lib/format'
import { useTheme } from '@/theme'
import { Screen } from '@/components/Screen'
import { NavBar, Pill, Empty, Button } from '@/components/ds'

// Horizontal filter chip — actions are derived from the loaded rows, so the
// set is unbounded; a scrollable chip strip beats Segmented here.
function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        height: 28, paddingHorizontal: 12, borderRadius: t.radiusPill,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: active ? t.primary : pressed ? t.sunken : t.surface,
        borderWidth: 1, borderColor: active ? 'transparent' : t.border,
      })}
    >
      <Text style={{ fontFamily: t.mono(500), fontSize: 11.5, color: active ? t.primaryFg : t.muted }}>
        {label}
      </Text>
    </Pressable>
  )
}

function AuditItem({ row, serverName, expanded, onToggle }: {
  row: AuditRow; serverName: string | null; expanded: boolean; onToggle: () => void
}) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      testID={`audit-row-${row.id}`}
      onPress={onToggle}
      style={({ pressed }) => ({
        paddingVertical: 10, paddingHorizontal: 14, gap: 6,
        backgroundColor: pressed ? t.sunken : 'transparent',
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Pill kind={row.result === 'ok' ? 'ok' : 'err'}>{row.result}</Pill>
        <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.mono(500), fontSize: t.fs.sm, color: t.text }}>
          {row.action}
        </Text>
        {serverName ? (
          <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.font(), fontSize: t.fs.xs, color: t.muted }}>
            {serverName}
          </Text>
        ) : null}
        <Text style={{ marginLeft: 'auto', fontFamily: t.font(), fontSize: t.fs.tiny, color: t.fgDim }}>
          {relTime(row.ts)}
        </Text>
      </View>
      {row.details ? (
        <Text
          testID={`audit-details-${row.id}`}
          numberOfLines={expanded ? undefined : 1}
          style={{ fontFamily: t.mono(), fontSize: t.fs.tiny, color: t.muted }}
        >
          {row.details}
        </Text>
      ) : null}
    </Pressable>
  )
}

export default function AuditLog() {
  const t = useTheme()
  const router = useRouter()
  const q = useAuditLog()
  const servers = useServers()
  const [actionFilter, setActionFilter] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  // server_id → display name: public alias when set, server name otherwise, '#id' last.
  const serverNames = useMemo(() => {
    const m = new Map<number, string>()
    for (const s of servers.data ?? []) m.set(s.id, nullStr(s.public_alias) || s.name || `#${s.id}`)
    return m
  }, [servers.data])

  const rows = useMemo(() => q.data ?? [], [q.data])
  const actions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) set.add(r.action)
    return [...set].sort(cmpStr)
  }, [rows])
  const visible = useMemo(
    () => (actionFilter ? rows.filter((r) => r.action === actionFilter) : rows),
    [rows, actionFilter],
  )

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Audit log' }} />
      <NavBar title="Audit log" backLabel="Settings" onBack={() => router.back()} />

      {q.isLoading ? (
        <ActivityIndicator color={t.primary} style={{ marginTop: t.space(8) }} />
      ) : q.isError ? (
        <View style={{ alignItems: 'center', gap: 12, padding: t.space(6) }}>
          <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.err }}>
            Failed to load the audit log.
          </Text>
          <Button variant="outline" icon="refresh-cw" onPress={() => { void q.refetch() }}>Retry</Button>
        </View>
      ) : (
        <View style={{ flex: 1 }}>
          {actions.length > 0 ? (
            <View style={{ borderBottomWidth: 1, borderBottomColor: t.border }}>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8 }}
              >
                <Chip label="all" active={actionFilter == null} onPress={() => setActionFilter(null)} />
                {actions.map((a) => (
                  <Chip key={a} label={a} active={actionFilter === a} onPress={() => setActionFilter(actionFilter === a ? null : a)} />
                ))}
              </ScrollView>
            </View>
          ) : null}

          <FlatList
            data={visible}
            keyExtractor={(r) => String(r.id)}
            contentContainerStyle={{ paddingBottom: 24 }}
            refreshControl={
              <RefreshControl
                refreshing={q.isRefetching}
                onRefresh={() => { void q.refetch() }}
                tintColor={t.muted}
              />
            }
            ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.border }} />}
            ListEmptyComponent={<Empty>{actionFilter ? 'No events for this action.' : 'No audit events yet.'}</Empty>}
            renderItem={({ item }) => (
              <AuditItem
                row={item}
                serverName={item.server_id == null ? null : (serverNames.get(item.server_id) ?? `#${item.server_id}`)}
                expanded={expandedId === item.id}
                onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
              />
            )}
          />
        </View>
      )}
    </Screen>
  )
}
