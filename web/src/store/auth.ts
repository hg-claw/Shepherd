import { create } from 'zustand'

export type Admin = { id: number; username: string }

type AuthState = {
  admin: Admin | null
  isLoaded: boolean
  setAdmin: (a: Admin | null) => void
  setLoaded: (v: boolean) => void
  clear: () => void
}

export const useAuth = create<AuthState>((set) => ({
  admin: null,
  isLoaded: false,
  setAdmin: (admin) => set({ admin, isLoaded: true }),
  setLoaded: (isLoaded) => set({ isLoaded }),
  clear: () => set({ admin: null }),
}))
