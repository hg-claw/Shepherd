import { useEffect, useState } from 'react'
import { View, Text, Pressable } from 'react-native'
import { authenticate } from '@/lib/biometrics'
import { useLock } from '@/store/lock'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export function LockScreen() {
  const unlock = useLock((s) => s.unlock)
  const logout = useAuth((s) => s.logout)
  const [failed, setFailed] = useState(false)

  const tryAuth = () => { authenticate().then((ok) => (ok ? unlock() : setFailed(true))).catch(() => setFailed(true)) }
  useEffect(() => {
    let live = true
    authenticate().then((ok) => { if (live) { if (ok) unlock(); else setFailed(true) } }).catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [unlock])

  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', gap: theme.space(5) }}>
      <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>🔒 Shepherd locked</Text>
      <Pressable onPress={tryAuth} style={{ backgroundColor: theme.accent, paddingVertical: theme.space(3), paddingHorizontal: theme.space(8), borderRadius: 8 }}>
        <Text style={{ color: theme.bg, fontWeight: '600' }}>Unlock</Text>
      </Pressable>
      {failed ? <Pressable onPress={logout}><Text style={{ color: theme.textDim }}>Sign out</Text></Pressable> : null}
    </View>
  )
}
