import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/theme'
import { Icon } from './Icon'

// .hdr: pad (inset+12)/16/12, bg-elev, bottom border. title 26/600; sub sm muted; actions right.
export function Header({ title, sub, actions }: {
  title: React.ReactNode; sub?: React.ReactNode; actions?: React.ReactNode
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{
      paddingTop: Math.max(insets.top, 24) + 12, paddingHorizontal: 16, paddingBottom: 12,
      backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border,
    }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Text style={{ fontFamily: t.font(600), fontSize: 26, letterSpacing: -0.26, color: t.text, flexShrink: 1 }}>
          {title}
        </Text>
        {actions ? (
          <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 6 }}>{actions}</View>
        ) : null}
      </View>
      {sub != null && sub !== '' ? (
        <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.muted, marginTop: 2 }}>{sub}</Text>
      ) : null}
    </View>
  )
}

// .navbar: min-height 92, pad 54/8/10, bg-elev, bottom border. left back (primary), centered title, actions right.
export function NavBar({ title, onBack, backLabel = 'Back', actions }: {
  title?: React.ReactNode; onBack?: () => void; backLabel?: string; actions?: React.ReactNode
}) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  const top = Math.max(insets.top, 24)
  return (
    <View style={{
      minHeight: top + 48, paddingTop: top + 10, paddingHorizontal: 8, paddingBottom: 10,
      backgroundColor: t.surface, borderBottomWidth: 1, borderBottomColor: t.border,
      flexDirection: 'row', alignItems: 'center', gap: 4,
    }}>
      <Pressable
        onPress={onBack}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 2, height: 36,
          paddingLeft: 4, paddingRight: 8, borderRadius: t.radius,
          backgroundColor: pressed ? t.sunken : 'transparent',
        })}
      >
        <Icon name="chevron-left" size={22} color={t.primary} />
        <Text style={{ fontFamily: t.font(), fontSize: t.fs.md, color: t.primary }}>{backLabel}</Text>
      </Pressable>
      {title != null ? (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' }}>
          <Text numberOfLines={1} style={{ fontFamily: t.font(600), fontSize: t.fs.md, letterSpacing: -0.14, color: t.text, maxWidth: '55%' }}>
            {title}
          </Text>
        </View>
      ) : null}
      {actions ? (
        <View style={{ marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 2 }}>{actions}</View>
      ) : null}
    </View>
  )
}

// .iconbtn: 36x36 radius, muted icon; sunken bg + fg on press.
export function IconButton({ name, onPress, size = 18, accessibilityLabel }: { name: string; onPress?: () => void; size?: number; accessibilityLabel?: string }) {
  const t = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 36, height: 36, borderRadius: t.radius, alignItems: 'center', justifyContent: 'center',
        backgroundColor: pressed ? t.sunken : 'transparent',
      })}
    >
      <Icon name={name} size={size} color={t.muted} />
    </Pressable>
  )
}

// .empty: centered dim text.
export function Empty({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return (
    <View style={{ paddingVertical: 40, paddingHorizontal: 24, alignItems: 'center' }}>
      <Text style={{ fontFamily: t.font(), fontSize: t.fs.sm, color: t.fgDim, textAlign: 'center' }}>{children}</Text>
    </View>
  )
}
