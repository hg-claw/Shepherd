import React from 'react'
import { View } from 'react-native'
import { useTheme } from '@/theme'

export type DotTone = 'ok' | 'warn' | 'err' | 'neutral'

export function Dot({ tone = 'ok', size = 7 }: { tone?: DotTone; size?: number }) {
  const t = useTheme()
  const bg = tone === 'ok' ? t.ok : tone === 'warn' ? t.warn : tone === 'err' ? t.err : t.fgDim
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg }} />
}

// .online-dot: 7px. online = ok with a 3px ok-soft ring; offline = fg-dim, no ring.
export function OnlineDot({ online }: { online: boolean }) {
  const t = useTheme()
  if (!online) return <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.fgDim }} />
  return (
    <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.ok, borderWidth: 3, borderColor: t.okSoft }} />
  )
}
