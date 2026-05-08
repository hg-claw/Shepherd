import { create } from 'zustand'

export interface Tab {
  id: string
  sid: string
  sessionId: number
  title: string
  kind: 'console' | 'script'
  status: 'connecting' | 'open' | 'exited'
  exitCode?: number
}

interface S {
  tabs: Tab[]
  active: string | null
  open: (t: Omit<Tab, 'status'>) => void
  close: (id: string) => void
  focus: (id: string) => void
  setStatus: (id: string, status: Tab['status'], exitCode?: number) => void
}

export const useConsoleTabs = create<S>((set) => ({
  tabs: [],
  active: null,
  open: (t) =>
    set((s) => {
      if (s.tabs.find((x) => x.id === t.id)) return { active: t.id }
      return { tabs: [...s.tabs, { ...t, status: 'connecting' as const }], active: t.id }
    }),
  close: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((x) => x.id !== id)
      return { tabs, active: tabs.length ? tabs[tabs.length - 1].id : null }
    }),
  focus: (id) => set({ active: id }),
  setStatus: (id, status, exitCode) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, status, exitCode } : t)),
    })),
}))
