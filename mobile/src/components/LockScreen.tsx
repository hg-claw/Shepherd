import { useEffect, useRef, useState } from 'react'
import { Modal, View, Text, Pressable } from 'react-native'
import { authenticate } from '@/lib/biometrics'
import { useLock } from '@/store/lock'
import { useAuth } from '@/store/auth'
import { useTheme } from '@/theme'
import { BrandMark, Button, Icon } from '@/components/ds'

export function LockScreen() {
  const t = useTheme()
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
      <View style={{
        flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center',
        gap: 22, padding: 40,
      }}>
        <BrandMark />
        <View style={{
          width: 84, height: 84, borderRadius: 9999, alignItems: 'center', justifyContent: 'center',
          backgroundColor: t.sunken, borderWidth: 1, borderColor: t.border,
        }}>
          <Icon name="scan-face" size={38} color={t.primary} />
        </View>
        <Text style={{ textAlign: 'center', fontSize: 13, color: t.muted }}>
          Locked · authenticate to continue
        </Text>
        <Button icon="scan-face" onPress={tryAuth}>Unlock with Face ID</Button>
        {failed ? (
          <Pressable onPress={() => { void logout() }}>
            <Text style={{ color: t.textDim }}>Sign out</Text>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  )
}
