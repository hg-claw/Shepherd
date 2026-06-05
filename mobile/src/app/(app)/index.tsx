import { FlatList, View, Text, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'
import { useServers, type ServerRow } from '@/api/servers'
import { isOnline, memPct } from '@/api/metrics'
import { bps, pct } from '@/lib/format'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

function Row({ row, onPress }: { row: ServerRow; onPress: () => void }) {
  const online = isOnline(row)
  const l = row.latest
  return (
    <Pressable onPress={onPress} style={{ padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border, opacity: online ? 1 : 0.55 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2) }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: online ? '#4ade80' : theme.textDim }} />
        <Text style={{ color: theme.text, fontWeight: '600', flex: 1 }}>{row.name}</Text>
        <Text style={{ color: theme.textDim, fontFamily: 'monospace', fontSize: 12 }}>
          {online && l ? `↓${bps(l.net_rx_bps ?? 0)} ↑${bps(l.net_tx_bps ?? 0)}` : '—'}
        </Text>
      </View>
      <Text style={{ color: theme.textDim, fontSize: 12, marginTop: theme.space(1) }}>
        {online && l ? `CPU ${pct(l.cpu_pct ?? null)}   MEM ${pct(memPct(l))}` : 'offline'}
      </Text>
    </Pressable>
  )
}

export default function ServerList() {
  const router = useRouter()
  const logout = useAuth((s) => s.logout)
  const q = useServers()
  const rows = (q.data ?? []).slice().sort((a, b) => {
    const oa = isOnline(a) ? 0 : 1, ob = isOnline(b) ? 0 : 1
    return oa - ob || a.name.localeCompare(b.name)
  })
  const onlineCount = rows.filter(isOnline).length

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(3), borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: '600', flex: 1 }}>Servers</Text>
        <Text style={{ color: theme.textDim, marginRight: theme.space(3) }}>{onlineCount}/{rows.length} online</Text>
        <Pressable onPress={logout}><Text style={{ color: theme.accent }}>Log out</Text></Pressable>
      </View>
      {q.isLoading ? (
        <ActivityIndicator color={theme.accent} style={{ marginTop: theme.space(8) }} />
      ) : q.isError ? (
        <Text style={{ color: theme.error, padding: theme.space(4) }}>{q.error instanceof Error ? q.error.message : 'failed to load'}</Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(s) => String(s.id)}
          renderItem={({ item }) => <Row row={item} onPress={() => router.push(`/(app)/server/${item.id}`)} />}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={q.refetch} tintColor={theme.accent} />}
          ListEmptyComponent={<Text style={{ color: theme.textDim, padding: theme.space(4) }}>No servers.</Text>}
        />
      )}
    </View>
  )
}
