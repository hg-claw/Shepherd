import React from 'react'
import { View, Text } from 'react-native'
import { useTheme } from '@/theme'
import type { PillKind } from './helpers'

// .pill: h20, padding 0 8, radius pill, mono 11; 6px dot. Pulse animation omitted (static dot).
export function Pill({ kind = 'neutral', children }: { kind?: PillKind; children: React.ReactNode }) {
  const t = useTheme()
  const map = {
    ok: { bg: t.okSoft, fg: t.ok, border: 'transparent' },
    warn: { bg: t.warnSoft, fg: t.warn, border: 'transparent' },
    err: { bg: t.errSoft, fg: t.err, border: 'transparent' },
    neutral: { bg: t.sunken, fg: t.muted, border: t.border },
  } as const
  const s = map[kind]
  return (
    <View
      style={{
        flexDirection: 'row', alignItems: 'center', gap: 6, height: 20,
        paddingHorizontal: 8, borderRadius: t.radiusPill, alignSelf: 'flex-start',
        backgroundColor: s.bg, borderWidth: 1, borderColor: s.border,
      }}
    >
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: s.fg }} />
      <Text style={{ fontFamily: t.mono(), fontSize: 11, letterSpacing: 0.1, color: s.fg }}>{children}</Text>
    </View>
  )
}
