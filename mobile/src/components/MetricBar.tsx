import { View, Text } from 'react-native'
import { theme } from '@/theme'

// A labeled horizontal usage bar. Tints warn ≥80, err ≥92 (web thresholds); dim when null.
export function MetricBar({ label, value }: { label: string; value: number | null }) {
  const v = value == null ? 0 : Math.min(100, Math.max(0, value))
  const color = value == null ? theme.textDim : value >= 92 ? theme.error : value >= 80 ? '#f0c060' : theme.accent
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space(2) }}>
      {label ? <Text style={{ color: theme.textDim, fontSize: 10, width: 30 }}>{label}</Text> : null}
      <View style={{ flex: 1, height: 6, backgroundColor: theme.surface, borderRadius: 3, overflow: 'hidden' }}>
        <View style={{ width: `${v}%` as `${number}%`, height: 6, backgroundColor: color }} />
      </View>
      <Text style={{ color: theme.textDim, fontSize: 10, width: 36, textAlign: 'right' }}>{value == null ? '—' : `${Math.round(value)}%`}</Text>
    </View>
  )
}
