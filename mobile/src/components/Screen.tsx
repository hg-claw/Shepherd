import type { ReactNode } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { theme } from '@/theme'

// Applies safe-area insets + the app background so screens clear the notch / status
// bar / home indicator. A screen with its own scroll can pass edges={['top']} and
// handle the bottom itself.
export function Screen({ children, edges = ['top', 'bottom'] }: { children: ReactNode; edges?: ('top' | 'bottom')[] }) {
  const i = useSafeAreaInsets()
  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: edges.includes('top') ? i.top : 0, paddingBottom: edges.includes('bottom') ? i.bottom : 0 }}>
      {children}
    </View>
  )
}
