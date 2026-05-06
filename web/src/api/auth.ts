import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'
import type { Admin } from '@/store/auth'

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<Admin>('/api/admins/me')
      } catch (e: any) {
        if (e?.status === 401) return null
        throw e
      }
    },
    staleTime: 5 * 60_000,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { username: string; password: string }) =>
      api.post<Admin>('/api/login', input),
    onSuccess: (admin) => {
      qc.setQueryData(['me'], admin)
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<void>('/api/logout'),
    onSuccess: () => {
      qc.setQueryData(['me'], null)
      qc.invalidateQueries()
    },
  })
}
