import React, { createContext, useContext, useMemo } from 'react'
import { create } from 'zustand'
import { TOKENS, hslOf, FONT, MONO, FS, RADIUS, type Mode, type TokenName } from './tokens'
import { saveThemeMode, loadThemeMode } from '../storage/secure'

export type { Mode } from './tokens'

export type Theme = {
  mode: Mode
  // raw token accessor, with optional alpha → hsl()/hsla() string
  c: (token: TokenName, alpha?: number) => string
  // surfaces / text
  bg: string; cardBg: string; surface: string; sunken: string
  text: string; muted: string; textDim: string; fgDim: string
  border: string; borderStrong: string; input: string
  primary: string; primaryFg: string; accent: string
  ok: string; okSoft: string; warn: string; warnSoft: string; err: string; errSoft: string; error: string
  destructive: string; destructiveFg: string
  // scales
  space: (n: number) => number
  radius: number; radiusSm: number; radiusLg: number; radiusPill: number
  fs: typeof FS
  font: (w?: 400 | 500 | 600 | 700) => string
  mono: (w?: 400 | 500 | 600) => string
}

export function makeTheme(mode: Mode): Theme {
  const t = TOKENS[mode]
  const c = (token: TokenName, alpha?: number) => hslOf(t[token], alpha)
  return {
    mode,
    c,
    bg: c('background'),
    cardBg: c('card'),
    surface: c('bgElev'),
    sunken: c('bgSunken'),
    text: c('foreground'),
    muted: c('muted'),
    textDim: c('muted'),
    fgDim: c('fgDim'),
    border: c('border'),
    borderStrong: c('borderStrong'),
    input: c('input'),
    primary: c('primary'),
    primaryFg: c('primaryFg'),
    accent: c('primary'),
    ok: c('ok'), okSoft: c('okSoft'),
    warn: c('warn'), warnSoft: c('warnSoft'),
    err: c('err'), errSoft: c('errSoft'), error: c('err'),
    destructive: c('destructive'), destructiveFg: c('destructiveFg'),
    space: (n: number) => n * 4,
    radius: RADIUS.base, radiusSm: RADIUS.sm, radiusLg: RADIUS.lg, radiusPill: RADIUS.pill,
    fs: FS,
    font: (w = 400) => FONT[w],
    mono: (w = 400) => MONO[w],
  }
}

// Static dark theme — backward-compatible for `import { theme } from '@/theme'`
// (used by non-component code and as the provider default).
export const theme = makeTheme('dark')

// ---- persisted theme-mode store ----
type ThemeModeState = {
  mode: Mode
  hydrated: boolean
  hydrate: () => Promise<void>
  setMode: (m: Mode) => Promise<void>
  toggle: () => Promise<void>
}
export const useThemeMode = create<ThemeModeState>((set, get) => ({
  mode: 'dark',
  hydrated: false,
  hydrate: async () => {
    const m = await loadThemeMode()
    set({ mode: m ?? 'dark', hydrated: true })
  },
  setMode: async (m) => { await saveThemeMode(m); set({ mode: m }) },
  toggle: async () => { await get().setMode(get().mode === 'dark' ? 'light' : 'dark') },
}))

// ---- provider / hook ----
const ThemeContext = createContext<Theme>(theme)
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const mode = useThemeMode((s) => s.mode)
  const value = useMemo(() => makeTheme(mode), [mode])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
export function useTheme(): Theme {
  return useContext(ThemeContext)
}
