import { useEffect, useState } from 'react'
import { View, Text, Switch, Pressable } from 'react-native'
import { Stack } from 'expo-router'
import { useLock } from '@/store/lock'
import { useAuth } from '@/store/auth'
import { hasHardware, isEnrolled } from '@/lib/biometrics'
import { theme } from '@/theme'
import { Screen } from '@/components/Screen'

export default function Settings() {
  const { enabled, setEnabled } = useLock()
  const logout = useAuth((s) => s.logout)
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    let live = true
    Promise.all([hasHardware(), isEnrolled()]).then(([hw, en]) => { if (live) setSupported(hw && en) }).catch(() => {})
    return () => { live = false }
  }, [])

  return (
    <Screen edges={['bottom']}>
      <Stack.Screen options={{ title: 'Settings' }} />
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: theme.space(4), borderBottomWidth: 1, borderColor: theme.border }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text }}>Require biometric unlock</Text>
          {!supported ? <Text style={{ color: theme.textDim, fontSize: 12, marginTop: theme.space(1) }}>No biometric hardware enrolled.</Text> : null}
        </View>
        <Switch testID="lock-toggle" value={enabled} disabled={!supported} onValueChange={(on) => setEnabled(on)} />
      </View>
      <Pressable onPress={logout} style={{ padding: theme.space(4) }}>
        <Text style={{ color: theme.error }}>Sign out</Text>
      </Pressable>
    </Screen>
  )
}
