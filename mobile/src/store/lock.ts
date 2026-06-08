import { create } from 'zustand'
import { saveLockEnabled, loadLockEnabled } from '../storage/secure'

const LOCK_AFTER_MS = 30_000

type LockState = {
  enabled: boolean
  locked: boolean
  hydrated: boolean
  lastBackground: number | null
  hydrate: () => Promise<void>
  setEnabled: (on: boolean) => Promise<void>
  lock: () => void
  unlock: () => void
  noteBackground: (now: number) => void
  maybeLockOnForeground: (now: number) => void
}

export const useLock = create<LockState>((set, get) => ({
  enabled: false,
  locked: false,
  hydrated: false,
  lastBackground: null,
  hydrate: async () => {
    const enabled = await loadLockEnabled()
    set({ enabled, locked: enabled, hydrated: true })
  },
  setEnabled: async (on) => {
    await saveLockEnabled(on)
    set({ enabled: on, locked: on })
  },
  lock: () => set({ locked: true }),
  unlock: () => set({ locked: false }),
  noteBackground: (now) => set({ lastBackground: now }),
  maybeLockOnForeground: (now) => {
    const { enabled, lastBackground } = get()
    if (enabled && lastBackground != null && now - lastBackground > LOCK_AFTER_MS) set({ locked: true })
  },
}))
