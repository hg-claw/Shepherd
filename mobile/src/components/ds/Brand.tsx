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

// .hdr-brand-tile: 24x24 r5, fg bg / bg fg, mono 700 13.
export function BrandTile() {
  const t = useTheme()
  return (
    <View style={{ width: 24, height: 24, borderRadius: 5, alignItems: 'center', justifyContent: 'center', backgroundColor: t.text }}>
      <Text style={{ fontFamily: t.mono(600), fontSize: 13, color: t.bg }}>Sh</Text>
    </View>
  )
}
