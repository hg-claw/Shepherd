import { create } from 'zustand'
import { loginRequest, logoutRequest } from '../api/auth'
import { saveToken, loadToken, clearToken, saveBaseURL, loadBaseURL } from '../storage/secure'

type Admin = { id: number; username: string }

type AuthState = {
  status: 'loading' | 'signedOut' | 'signedIn'
  baseURL: string | null
  token: string | null
  admin: Admin | null
  error: string | null
  restore: () => Promise<void>
  login: (baseURL: string, username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  clearSession: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  baseURL: null,
  token: null,
  admin: null,
  error: null,

  restore: async () => {
    const [token, baseURL] = [await loadToken(), await loadBaseURL()]
    if (token && baseURL) set({ status: 'signedIn', token, baseURL })
    else set({ status: 'signedOut' })
  },

  login: async (baseURL, username, password) => {
    set({ error: null })
    try {
      const r = await loginRequest(baseURL, username, password)
      await saveToken(r.token)
      await saveBaseURL(baseURL)
      set({ status: 'signedIn', token: r.token, baseURL, admin: { id: r.id, username: r.username }, error: null })
    } catch (e) {
      set({ status: 'signedOut', error: e instanceof Error ? e.message : 'login failed' })
    }
  },

  logout: async () => {
    const { baseURL, token } = get()
    if (baseURL && token) await logoutRequest(baseURL, token)
    await get().clearSession()
  },

  clearSession: async () => {
    await clearToken()
    set({ status: 'signedOut', token: null, admin: null })
  },
}))
