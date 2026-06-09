import React from 'react'
import { View, Text, type ViewStyle, type StyleProp } from 'react-native'
import { useTheme } from '@/theme'

// .card: bg-elev, border, radius-lg.
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme()
  return (
    <View style={[{ backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: t.radiusLg }, style]}>
      {children}
    </View>
  )
}

// .card-head: pad 12/14, bottom border, row gap 8.
export function CardHead({ children }: { children: React.ReactNode }) {
  const t = useTheme()
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingVertical: 12, paddingHorizontal: 14,
      borderBottomWidth: 1, borderBottomColor: t.border,
    }}>
      {typeof children === 'string' ? (
        <Text style={{ fontFamily: t.font(500), fontSize: 12.5, color: t.text }}>{children}</Text>
      ) : children}
    </View>
  )
}
