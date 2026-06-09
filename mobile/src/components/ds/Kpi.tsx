import React from 'react'
import { View, Text } from 'react-native'
import { useTheme } from '@/theme'

type Tone = 'ok' | 'warn' | 'err'

// .kpi: bg-elev, border, radius-lg, pad 12/13. label uppercase micro muted; value mono 26; sub mono 11.
export function Kpi({ label, value, sub, tone }: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone
}) {
  const t = useTheme()
  const tc = tone === 'ok' ? t.ok : tone === 'warn' ? t.warn : tone === 'err' ? t.err : t.text
  return (
    <View style={{
      backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
      borderRadius: t.radiusLg, paddingVertical: 12, paddingHorizontal: 13,
    }}>
      <Text style={{ fontFamily: t.font(), fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.5, color: t.muted }}>
        {label}
      </Text>
      <Text style={{ fontFamily: t.mono(), fontSize: 26, lineHeight: 26, marginTop: 7, letterSpacing: -0.26, color: tc }}>
        {value}
      </Text>
      {sub != null && sub !== '' ? (
        <Text style={{ fontFamily: t.mono(), fontSize: 11, color: t.muted, marginTop: 6 }}>{sub}</Text>
      ) : null}
    </View>
  )
}
