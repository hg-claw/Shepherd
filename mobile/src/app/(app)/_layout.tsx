import { Redirect, Slot } from 'expo-router'
import { useAuth } from '@/store/auth'

export default function AppLayout() {
  const status = useAuth((s) => s.status)
  if (status !== 'signedIn') return <Redirect href="/(auth)/login" />
  return <Slot />
}
