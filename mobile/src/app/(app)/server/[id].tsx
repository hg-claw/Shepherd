import { View, Text } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { useServer } from '@/api/servers'
import { isOnline, memPct, firstDiskPct } from '@/api/metrics'
import { bps, pct, relTime } from '@/lib/format'
import { theme } from '@/theme'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: theme.space(2), borderBottomWidth: 1, borderColor: theme.border }}>
      <Text style={{ color: theme.textDim }}>{label}</Text>
      <Text style={{ color: theme.text, fontFamily: 'monospace' }}>{value}</Text>
    </View>
  )
}

export default function ServerDetail() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const row = useServer(Number(id))
  if (!row) {
    return <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(5) }}><Text style={{ color: theme.textDim }}>Server not found.</Text></View>
  }
  const l = row.latest
  const lastSeen = typeof row.agent_last_seen === 'object' && row.agent_last_seen?.Valid ? row.agent_last_seen.Time : null
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, padding: theme.space(4) }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '600' }}>{row.name}</Text>
      <Text style={{ color: isOnline(row) ? '#4ade80' : theme.textDim, marginBottom: theme.space(3) }}>{isOnline(row) ? 'online' : 'offline'}</Text>
      <Stat label="CPU" value={pct(l?.cpu_pct ?? null)} />
      <Stat label="Memory" value={pct(memPct(l ?? null))} />
      <Stat label="Disk" value={pct(firstDiskPct(l?.disks_json))} />
      <Stat label="Net" value={l ? `↓ ${bps(l.net_rx_bps ?? 0)}  ↑ ${bps(l.net_tx_bps ?? 0)}` : '—'} />
      <Stat label="Load (1m)" value={l?.load_1 != null ? l.load_1.toFixed(2) : '—'} />
      <Stat label="TCP conns" value={l?.tcp_conn != null ? String(l.tcp_conn) : '—'} />
      <Stat label="OS / Arch" value={`${row.agent_os ?? '—'} / ${row.agent_arch ?? '—'}`} />
      <Stat label="Last seen" value={lastSeen ? relTime(lastSeen) : '—'} />
    </View>
  )
}
