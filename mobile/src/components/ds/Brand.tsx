import React from 'react'
import { View, Text } from 'react-native'
import { useTheme } from '@/theme'

// .cc: mono 10, pad 1/5, r3, bg-sunken, muted.
export function Cc({ code }: { code?: string | null }) {
  const t = useTheme()
  if (!code) return null
  return (
    <View style={{ backgroundColor: t.sunken, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, alignSelf: 'flex-start' }}>
      <Text style={{ fontFamily: t.mono(), fontSize: 10, letterSpacing: 0.5, color: t.muted }}>{code}</Text>
    </View>
  )
}

// .login-mark: centered `[ Shepherd ]` with a glowing primary dot.
export function BrandMark() {
  const t = useTheme()
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 }}>
      <View style={{
        width: 9, height: 9, borderRadius: 9999, backgroundColor: t.primary,
        shadowColor: t.primary, shadowOpacity: 0.8, shadowRadius: 10, shadowOffset: { width: 0, height: 0 }, elevation: 4,
      }} />
      <Text style={{ fontFamily: t.mono(), fontSize: 16, color: t.muted }}>[</Text>
      <Text style={{ fontFamily: t.mono(600), fontSize: 15, letterSpacing: 2.7, color: t.text }}>SHEPHERD</Text>
      <Text style={{ fontFamily: t.mono(), fontSize: 16, color: t.muted }}>]</Text>
    </View>
  )
}

// .hdr-brand-tile: 24x24 r5, fg bg / bg fg, mono 700 13.
export function BrandTile() {
  const t = useTheme()
  return (
    <View style={{ width: 24, height: 24, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: t.text }}>
      <Text style={{ fontFamily: t.mono(600), fontSize: 13, color: t.bg }}>Sh</Text>
    </View>
  )
}
