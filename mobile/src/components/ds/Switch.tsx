import React from 'react'
import { View, Pressable } from 'react-native'
import { useTheme } from '@/theme'

// .switch: 51x31 r9999, track input -> ok when on. thumb 27 white, left 2 -> 22.
export function Switch({ on, onChange, disabled, testID }: {
  on: boolean; onChange: (next: boolean) => void; disabled?: boolean; testID?: string
}) {
  const t = useTheme()
  return (
    <Pressable
      testID={testID}
      accessibilityRole="switch"
      accessibilityState={{ checked: on, disabled: !!disabled }}
      onPress={() => { if (!disabled) onChange(!on) }}
      style={{
        width: 51, height: 31, borderRadius: 9999,
        backgroundColor: on ? t.ok : t.input, opacity: disabled ? 0.45 : 1,
      }}
    >
      <View style={{
        position: 'absolute', top: 2, left: on ? 22 : 2,
        width: 27, height: 27, borderRadius: 27 / 2, backgroundColor: '#fff',
        shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2,
      }} />
    </Pressable>
  )
}
