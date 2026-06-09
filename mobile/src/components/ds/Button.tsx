import React from 'react'
import { Text, Pressable } from 'react-native'
import { useTheme } from '@/theme'
import { Icon } from './Icon'

type Variant = 'primary' | 'outline' | 'danger' | 'ghost'

// .btn: h44, pad 0/16, radius, md/500, gap 7. variants per CSS; active states approximated via pressed.
export function Button({
  variant = 'primary', children, onPress, disabled, block, icon, testID,
}: {
  variant?: Variant
  children: React.ReactNode
  onPress?: () => void
  disabled?: boolean
  block?: boolean
  icon?: string
  testID?: string
}) {
  const t = useTheme()
  const styleFor = (pressed: boolean) => {
    switch (variant) {
      case 'primary':
        return { bg: pressed ? t.c('primary', 0.85) : t.primary, fg: t.primaryFg, border: 'transparent' }
      case 'outline':
        return { bg: pressed ? t.sunken : t.surface, fg: t.text, border: t.border }
      case 'danger':
        return { bg: t.destructive, fg: t.destructiveFg, border: 'transparent' }
      case 'ghost':
      default:
        return { bg: pressed ? t.sunken : 'transparent', fg: t.text, border: 'transparent' }
    }
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => {
        const s = styleFor(pressed)
        return {
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
          height: 44, paddingHorizontal: 16, borderRadius: t.radius,
          borderWidth: 1, borderColor: s.border, backgroundColor: s.bg,
          opacity: disabled ? 0.5 : 1, alignSelf: block ? 'stretch' : 'flex-start',
          width: block ? '100%' : undefined,
        }
      }}
    >
      {({ pressed }) => {
        const fg = styleFor(pressed).fg
        return (
          <>
            {icon ? <Icon name={icon} size={16} color={fg} /> : null}
            <Text style={{ fontFamily: t.font(500), fontSize: t.fs.md, color: fg }}>{children}</Text>
          </>
        )
      }}
    </Pressable>
  )
}
