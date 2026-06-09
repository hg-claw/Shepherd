import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { useTheme } from '@/theme'
import { Icon } from './Icon'

// .lrow: min-height 52, pad 10/14, gap 12. icon tile 30x30 r7 bg-sunken; title flex md; detail mono 12 muted; chevron fg-dim.
export function ListRow({
  icon, iconColor, title, titleColor, sub, detail, chevron = true, mono, onPress, right,
}: {
  icon?: string
  iconColor?: string
  title: React.ReactNode
  titleColor?: string
  sub?: React.ReactNode
  detail?: React.ReactNode
  chevron?: boolean
  mono?: boolean
  onPress?: () => void
  right?: React.ReactNode
}) {
  const t = useTheme()
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 12,
        minHeight: 52, paddingVertical: 10, paddingHorizontal: 14,
        backgroundColor: pressed && onPress ? t.sunken : 'transparent',
      })}
    >
      {icon ? (
        <View style={{
          width: 30, height: 30, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
          backgroundColor: t.sunken,
        }}>
          <Icon name={icon} size={16} color={iconColor ?? t.muted} />
        </View>
      ) : null}
      {/* A node title (e.g. a two-line View) must render as a sibling, NOT inside a
          <Text> — a View nested in Text crashes on native. Wrap only string titles. */}
      <View style={{ flex: 1, minWidth: 0 }}>
        {typeof title === 'string' ? (
          <Text numberOfLines={1} style={{ fontSize: t.fs.md, color: titleColor ?? t.text, fontFamily: mono ? t.mono() : t.font() }}>
            {title}
          </Text>
        ) : title}
        {sub != null && sub !== '' ? (
          <Text numberOfLines={1} style={{ fontSize: t.fs.xs, color: t.muted, marginTop: 1, fontFamily: t.font() }}>{sub}</Text>
        ) : null}
      </View>
      {detail != null && detail !== '' ? (
        <Text numberOfLines={1} style={{ fontFamily: t.mono(), fontSize: 12, color: t.muted }}>{detail}</Text>
      ) : null}
      {right}
      {chevron ? <Icon name="chevron-right" size={16} color={t.fgDim} /> : null}
    </Pressable>
  )
}

// .list: bordered rounded container; rows separated by hairline top borders (.lrow + .lrow).
export function List({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  const items = React.Children.toArray(children)
  return (
    <View style={{
      backgroundColor: t.surface, borderWidth: 1, borderColor: t.border,
      borderRadius: t.radiusLg, overflow: 'hidden',
    }}>
      {items.map((child, i) => (
        <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: t.border } : undefined}>
          {child}
        </View>
      ))}
    </View>
  )
}

export const ListGroup = List
