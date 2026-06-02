import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { View, ActivityIndicator } from 'react-native'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export default function RootLayout() {
  const status = useAuth((s) => s.status)
  const restore = useAuth((s) => s.restore)
  useEffect(() => { restore() }, [restore])

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }} />
}
