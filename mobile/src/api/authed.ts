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
