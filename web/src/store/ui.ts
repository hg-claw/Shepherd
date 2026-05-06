import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type ThemeMode = 'system' | 'light' | 'dark'
export type Lang = 'zh-CN' | 'en'

export type ToastKind = 'info' | 'error' | 'success'
export type Toast = { id: number; kind: ToastKind; message: string }

type UIState = {
  themeMode: ThemeMode
  lang: Lang
  toasts: Toast[]
  setTheme: (m: ThemeMode) => void
  setLang: (l: Lang) => void
  toast: (kind: ToastKind, message: string) => void
  dismissToast: (id: number) => void
}

let toastSeq = 1

export const useUI = create<UIState>()(
  persist(
    (set) => ({
      themeMode: 'system',
      lang: 'zh-CN',
      toasts: [],
      setTheme: (themeMode) => set({ themeMode }),
      setLang: (lang) => set({ lang }),
      toast: (kind, message) =>
        set((s) => ({ toasts: [...s.toasts, { id: toastSeq++, kind, message }] })),
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: 'shepherd-ui',
      partialize: (s) => ({ themeMode: s.themeMode, lang: s.lang }),
    },
  ),
)
