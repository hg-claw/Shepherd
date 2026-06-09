import React from 'react'
import { View, Text, Pressable } from 'react-native'
import { useTheme } from '@/theme'

// .seg: bordered inline group, h32, bg-elev. buttons pad 0/14 mono 12 muted, divider border-right. active = bg-sunken + fg.
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  const t = useTheme()
  return (
    <View style={{
      flexDirection: 'row', alignSelf: 'flex-start', height: 32,
      borderWidth: 1, borderColor: t.border, borderRadius: t.radius, overflow: 'hidden',
      backgroundColor: t.surface,
    }}>
      {options.map((o, i) => {
        const active = o.value === value
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            style={{
              paddingHorizontal: 14, justifyContent: 'center',
              backgroundColor: active ? t.sunken : 'transparent',
              borderLeftWidth: i > 0 ? 1 : 0, borderLeftColor: t.border,
            }}
          >
            <Text style={{ fontFamily: t.mono(), fontSize: 12, color: active ? t.text : t.muted }}>{o.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
