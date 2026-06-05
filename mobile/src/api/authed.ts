import { apiFetch, APIError } from './client'
import { useAuth } from '../store/auth'

// authedFetch issues an authenticated request using the current session
// (baseURL + token from the auth store). On a 401 it clears the session so the
// routing gate bounces to login, then re-throws.
export async function authedFetch<T>(path: string, opts?: { method?: string; body?: unknown }): Promise<T> {
  const { baseURL, token } = useAuth.getState()
  if (!baseURL) throw new APIError(401, 'not signed in')
  try {
    return await apiFetch<T>(baseURL, token, path, opts)
  } catch (e) {
    if (e instanceof APIError && e.status === 401) {
      await useAuth.getState().clearSession()
    }
    throw e
  }
}

export async function authedText(path: string): Promise<string> {
  const { baseURL, token } = useAuth.getState()
  if (!baseURL) throw new APIError(401, 'not signed in')
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${baseURL}${path}`, { headers })
  const body = await res.text().catch(() => '')
  if (!res.ok) {
    if (res.status === 401) await useAuth.getState().clearSession()
    throw new APIError(res.status, body || `request failed (${res.status})`)
  }
  return body
}
