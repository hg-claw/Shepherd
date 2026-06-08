import { useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { Redirect, Slot } from 'expo-router'
import { useAuth } from '@/store/auth'
import { useLock } from '@/store/lock'
import { LockScreen } from '@/components/LockScreen'
import { useWallLiveConnection } from '@/api/wallLive'

export default function AppLayout() {
  const status = useAuth((s) => s.status)
  const { enabled, locked, hydrated, hydrate, noteBackground, maybeLockOnForeground } = useLock()
  useWallLiveConnection()
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
  // Don't paint protected content until the lock flag is read — otherwise it
  // flashes unlocked for a frame before hydrate() resolves (security gap).
  if (!hydrated) return null
  return (
    <>
      <Slot />
      {enabled && locked ? <LockScreen /> : null}
    </>
  )
}
