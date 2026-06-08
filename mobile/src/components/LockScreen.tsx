import { useEffect, useRef, useState } from 'react'
import { Modal, View, Text, Pressable } from 'react-native'
import { authenticate } from '@/lib/biometrics'
import { useLock } from '@/store/lock'
import { useAuth } from '@/store/auth'
import { theme } from '@/theme'

export function LockScreen() {
  const unlock = useLock((s) => s.unlock)
  const logout = useAuth((s) => s.logout)
  const [failed, setFailed] = useState(false)
  const mounted = useRef(true)
  const inFlight = useRef(false)

  // Coalesces concurrent prompts (StrictMode double-mount / fast re-taps) and
  // guards against resolving onto an unmounted tree (e.g. a 401 tears the
  // (app) subtree down while the native prompt is still open).
  const tryAuth = () => {
    if (inFlight.current) return
    inFlight.current = true
    authenticate()
      .then((ok) => { if (mounted.current) { if (ok) unlock(); else setFailed(true) } })
      .catch(() => { if (mounted.current) setFailed(true) })
      .finally(() => { inFlight.current = false })
  }
  useEffect(() => {
    mounted.current = true
    tryAuth()
    return () => { mounted.current = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A native Modal sits above the navigator so its gestures (edge-swipe-back,
  // scroll) can't leak through to the protected content while locked.
  return (
    <Modal visible animationType="fade" transparent={false} onRequestClose={() => {}}>
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center', gap: theme.space(5) }}>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: '700' }}>🔒 Shepherd locked</Text>
        <Pressable onPress={tryAuth} style={{ backgroundColor: theme.accent, paddingVertical: theme.space(3), paddingHorizontal: theme.space(8), borderRadius: 8 }}>
          <Text style={{ color: theme.bg, fontWeight: '600' }}>Unlock</Text>
        </Pressable>
        {failed ? <Pressable onPress={logout}><Text style={{ color: theme.textDim }}>Sign out</Text></Pressable> : null}
      </View>
    </Modal>
  )
}
