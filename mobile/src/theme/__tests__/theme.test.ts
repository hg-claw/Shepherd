import { makeTheme, useThemeMode } from '../index'
import { hslOf } from '../tokens'

test('hslOf renders triplets with/without alpha', () => {
  expect(hslOf('217 89% 47%')).toBe('hsl(217, 89%, 47%)')
  expect(hslOf('217 89% 47%', 0.25)).toBe('hsla(217, 89%, 47%, 0.25)')
})

test('makeTheme exposes the legacy + design tokens and differs by mode', () => {
  const dark = makeTheme('dark')
  const light = makeTheme('light')
  // legacy keys still present (used by existing screens)
  for (const k of ['bg', 'surface', 'border', 'text', 'textDim', 'accent', 'error'] as const) {
    expect(typeof dark[k]).toBe('string')
  }
  expect(dark.space(3)).toBe(12)
  expect(dark.bg).not.toBe(light.bg)
  expect(dark.font(600)).toBe('Geist_600SemiBold')
  expect(dark.mono()).toBe('GeistMono_400Regular')
})

test('theme-mode store toggles and persists', async () => {
  useThemeMode.setState({ mode: 'dark', hydrated: false })
  await useThemeMode.getState().toggle()
  expect(useThemeMode.getState().mode).toBe('light')
  await useThemeMode.getState().hydrate()
  expect(useThemeMode.getState().hydrated).toBe(true)
  expect(useThemeMode.getState().mode).toBe('light') // persisted
})
