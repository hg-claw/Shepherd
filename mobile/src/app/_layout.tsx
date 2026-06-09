import { useEffect, useState } from 'react'
import { Stack } from 'expo-router'
import { View, ActivityIndicator } from 'react-native'
import { useFonts } from 'expo-font'
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from '@expo-google-fonts/geist'
import { GeistMono_400Regular, GeistMono_500Medium, GeistMono_600SemiBold } from '@expo-google-fonts/geist-mono'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useAuth } from '@/store/auth'
import { theme, ThemeProvider, useThemeMode } from '@/theme'

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient())
  const status = useAuth((s) => s.status)
  const restore = useAuth((s) => s.restore)
  const hydrateTheme = useThemeMode((s) => s.hydrate)
  useEffect(() => { restore(); hydrateTheme() }, [restore, hydrateTheme])
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
