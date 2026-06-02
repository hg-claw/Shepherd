import { apiFetch, APIError } from './client'

export type LoginResult = { id: number; username: string; token: string }

export async function loginRequest(baseURL: string, username: string, password: string): Promise<LoginResult> {
  const r = await apiFetch<{ id: number; username: string; token?: string }>(
    baseURL, null, '/api/login', { body: { username, password, client: 'mobile' } },
  )
  if (!r.token) {
    throw new APIError(500, 'server did not return a token (update the server to v0.23+)')
  }
  return { id: r.id, username: r.username, token: r.token }
}

export async function logoutRequest(baseURL: string, token: string): Promise<void> {
  await apiFetch<unknown>(baseURL, token, '/api/logout', { method: 'POST' }).catch(() => {})
}
