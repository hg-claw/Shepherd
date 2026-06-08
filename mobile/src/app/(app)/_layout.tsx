import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { Redirect, Slot } from 'expo-router'
import { useAuth } from '@/store/auth'
import { useLock } from '@/store/lock'
import { LockScreen } from '@/components/LockScreen'

export default function AppLayout() {
  const status = useAuth((s) => s.status)
  const { enabled, locked, hydrate, noteBackground, maybeLockOnForeground } = useLock()
  const appState = useRef<AppStateStatus>(AppState.currentState)

  useEffect(() => { hydrate() }, [hydrate])
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appState.current
      appState.current = next
      if (next === 'active' && /inactive|background/.test(prev)) maybeLockOnForeground(Date.now())
      else if (/inactive|background/.test(next)) noteBackground(Date.now())
    })
    return () => sub.remove()
  }, [noteBackground, maybeLockOnForeground])

  if (status !== 'signedIn') return <Redirect href="/(auth)/login" />
  return (
    <>
      <Slot />
      {enabled && locked ? <LockScreen /> : null}
    </>
  )
}
