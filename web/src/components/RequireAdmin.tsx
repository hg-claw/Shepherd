import { Navigate } from 'react-router-dom'
import { useMe } from '@/api/auth'
import { useEffect } from 'react'
import { useAuth } from '@/store/auth'
import type { ReactNode } from 'react'

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data, isLoading } = useMe()
  const { setAdmin, setLoaded } = useAuth()

  useEffect(() => {
    if (!isLoading) {
      setAdmin(data ?? null)
      setLoaded(true)
    }
  }, [data, isLoading, setAdmin, setLoaded])

  if (isLoading) return null
  if (!data) return <Navigate to="/admin/login" replace />
  return <>{children}</>
}
