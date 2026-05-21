import { useQuery } from '@tanstack/react-query'
import { api } from './client'

export interface VersionResponse {
  version: string
}

// useVersion fetches the server's BuildVersion once and caches it for the
// session. Surfaced in the admin side nav + Settings page so the version
// label tracks releases instead of going stale (pre-fix it was hardcoded
// to "v0.2.1" and lagged by months).
export function useVersion() {
  return useQuery({
    queryKey: ['version'],
    queryFn: () => api.get<VersionResponse>('/api/version'),
    staleTime: Infinity, // server BuildVersion is fixed at boot
  })
}
