import { View, Text, Pressable } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '@/theme'
import { Icon } from './Icon'

type TabBarProps = {
  state: { index: number; routes: { key: string; name: string }[] }
  navigation: { navigate: (name: string) => void; emit: (e: { type: 'tabPress'; target: string; canPreventDefault: boolean }) => { defaultPrevented: boolean } }
}
const META: Record<string, { label: string; icon: string }> = {
  index: { label: 'Servers', icon: 'server' },
  plugins: { label: 'Plugins', icon: 'puzzle' },
  settings: { label: 'Settings', icon: 'settings' },
}
export function TabBar({ state, navigation }: TabBarProps) {
  const t = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <View style={{ flexDirection: 'row', paddingTop: 8, paddingHorizontal: 8, paddingBottom: Math.max(insets.bottom, 12), backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.border }}>
      {state.routes.map((route, i) => {
        const meta = META[route.name]
        if (!meta) return null
        const focused = state.index === i
        const color = focused ? t.primary : t.fgDim
        const onPress = () => {
          const ev = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true })
          if (!focused && !ev.defaultPrevented) navigation.navigate(route.name)
        }
        return (
          <Pressable
            key={route.key}
            onPress={onPress}
            accessibilityRole="tab"
            accessibilityLabel={meta.label}
            accessibilityState={{ selected: focused }}
            style={{ flex: 1, alignItems: 'center', gap: 3, paddingVertical: 4 }}
          >
            <Icon name={meta.icon} size={22} color={color} />
            <Text style={{ fontSize: 10.5, fontFamily: t.font(500), color }}>{meta.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}
