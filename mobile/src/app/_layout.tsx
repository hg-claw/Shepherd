import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import { View, ActivityIndicator, AppState, type AppStateStatus } from 'react-native'
import { useFonts } from 'expo-font'
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from '@expo-google-fonts/geist'
import { GeistMono_400Regular, GeistMono_500Medium, GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useAuth } from '@/store/auth'
import { theme, ThemeProvider, useThemeMode } from '@/theme'

// TanStack Query's refetchOnWindowFocus is a no-op on React Native — "focus"
// must be bridged from AppState. Exported for tests.
export function onAppStateChange(status: AppStateStatus) {
  focusManager.setFocused(status === 'active')
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient())
  const status = useAuth((s) => s.status)
  const restore = useAuth((s) => s.restore)
  const hydrateTheme = useThemeMode((s) => s.hydrate)
  useEffect(() => { restore(); hydrateTheme() }, [restore, hydrateTheme])
  useEffect(() => {
    const sub = AppState.addEventListener('change', onAppStateChange)
    return () => sub.remove()
  }, [])
  const [fontsLoaded] = useFonts({
    Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold,
    GeistMono_400Regular, GeistMono_500Medium, GeistMono_600SemiBold,
  })

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          {status === 'loading' || !fontsLoaded ? (
            <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color={theme.accent} />
            </View>
          ) : (
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }} />
          )}
        </QueryClientProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
