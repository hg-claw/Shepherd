import { useQueryClient } from '@tanstack/react-query'
import { authedFetch } from './authed'

// Script-install flow — mirrors web/src/api/servers.ts useScriptInstall.
// POST /api/servers/script creates a server row with no SSH credentials and
// returns a one-shot curl|bash install command (the agent fills in connection
// metadata via auto-register on first WS connect).
export type ScriptInstallInput = {
  name: string
  public_alias?: string
  public_group?: string
  country_code?: string
  show_on_public: boolean
  // When the target host is in mainland China and can't reach github.com
  // directly, set cn=true. Routes both the script URL and the install-time
  // release-asset downloads through https://gh-proxy.com/.
  cn?: boolean
}

export type ScriptInstallResult = {
  server_id: number
  token: string
  // RFC3339 stamp from the Go backend (time.Time JSON encoding).
  expires_at: string
  command: string
}

export function scriptInstall(input: ScriptInstallInput): Promise<ScriptInstallResult> {
  return authedFetch<ScriptInstallResult>('/api/servers/script', { method: 'POST', body: input })
}

// useScriptInstall returns scriptInstall wrapped with a servers-list
// invalidation on success — the backend creates the server row immediately,
// so the home list should refetch (same as the web mutation's onSuccess).
export function useScriptInstall(): (input: ScriptInstallInput) => Promise<ScriptInstallResult> {
  const qc = useQueryClient()
  return async (input: ScriptInstallInput) => {
    const r = await scriptInstall(input)
    void qc.invalidateQueries({ queryKey: ['servers'] })
    return r
  }
}
