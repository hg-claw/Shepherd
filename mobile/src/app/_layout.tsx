import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import { View, ActivityIndicator } from 'react-native'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient())
  const status = useAuth((s) => s.status)
  const restore = useAuth((s) => s.restore)
  useEffect(() => { restore() }, [restore])

  return (
    <QueryClientProvider client={queryClient}>
      {status === 'loading' ? (
        <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.accent} />
        </View>
      ) : (
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }} />
      )}
    </QueryClientProvider>
  )
}
