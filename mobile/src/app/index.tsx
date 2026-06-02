import { Redirect } from 'expo-router'
import { useAuth } from '@/store/auth'

export default function Index() {
  const status = useAuth((s) => s.status)
  return <Redirect href={status === 'signedIn' ? '/(app)' : '/(auth)/login'} />
}
