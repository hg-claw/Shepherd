import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from './client'

export type Settings = Record<string, string>

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<Settings>('/api/settings'),
    staleTime: 5 * 60_000,
  })
}

export function usePatchSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<Settings>) => api.patch<Settings>('/api/settings', input),
    onSuccess: (data) => qc.setQueryData(['settings'], data),
  })
}
