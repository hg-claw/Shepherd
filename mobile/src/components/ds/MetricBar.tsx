import React from 'react'
import { View, Text } from 'react-native'
import { useTheme } from '@/theme'
import { barKind } from './helpers'

// .mbar: row gap 9. label mono 10 w26; track flex h6 r3 bg-sunken; fill primary (warn>=80, err>=92); value mono 11 w34 right.
export function MetricBar({ label, value }: { label?: string; value: number | null }) {
  const t = useTheme()
  const v = value == null ? 0 : Math.min(100, Math.max(0, value))
  const kind = barKind(value)
  const fill = kind === 'err' ? t.err : kind === 'warn' ? t.warn : t.primary
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 9 }}>
      {label ? (
        <Text style={{ fontFamily: t.mono(), fontSize: 10, width: 26, letterSpacing: 0.4, color: t.muted }}>{label}</Text>
      ) : null}
      <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: t.sunken, overflow: 'hidden' }}>
        <View style={{ width: `${v}%` as `${number}%`, height: 6, borderRadius: 3, backgroundColor: fill }} />
      </View>
      <Text style={{ fontFamily: t.mono(), fontSize: 11, width: 34, textAlign: 'right', color: t.muted }}>
        {value == null ? '—' : `${Math.round(value)}%`}
      </Text>
    </View>
  )
}
