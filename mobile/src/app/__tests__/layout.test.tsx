import React from 'react'
import { render, act } from '@testing-library/react-native'
import { focusManager } from '@tanstack/react-query'
import { StatusBar } from 'expo-status-bar'
import { Stack } from 'expo-router'
import { makeTheme, useThemeMode } from '@/theme'
import RootLayout, { onAppStateChange } from '../_layout'

// _layout renders <Stack/> inline — keep the route mock shape expo-router-safe.
jest.mock('expo-router', () => ({ Stack: Object.assign(jest.fn(() => null), { Screen: () => null }) }))
jest.mock('expo-status-bar', () => ({ StatusBar: jest.fn(() => null) }))
jest.mock('@/store/auth', () => ({
  useAuth: (sel: (s: { status: string; restore: () => void }) => unknown) =>
    sel({ status: 'authed', restore: jest.fn() }),
}))

const lastProps = <T,>(fn: unknown): T => {
  const calls = (fn as jest.Mock).mock.calls
  return calls[calls.length - 1][0] as T
}
type StatusBarProps = { style: string }
type StackProps = { screenOptions: { contentStyle: { backgroundColor: string } } }

afterEach(async () => {
  // The theme-mode store is module-global — reset to the dark default.
  await act(async () => { await useThemeMode.getState().setMode('dark') })
})

test('AppState changes drive the TanStack Query focusManager', () => {
  const spy = jest.spyOn(focusManager, 'setFocused')
  onAppStateChange('active')
  expect(spy).toHaveBeenLastCalledWith(true)
  onAppStateChange('background')
  expect(spy).toHaveBeenLastCalledWith(false)
  onAppStateChange('inactive')
  expect(spy).toHaveBeenLastCalledWith(false)
  spy.mockRestore()
  focusManager.setFocused(undefined) // restore default focus detection
})

test('dark mode: light status bar text and dark navigation background', async () => {
  render(<RootLayout />)
  await act(async () => {}) // flush the theme-hydrate effect
  expect(lastProps<StatusBarProps>(StatusBar).style).toBe('light')
  expect(lastProps<StackProps>(Stack).screenOptions.contentStyle.backgroundColor)
    .toBe(makeTheme('dark').bg)
})

test('light mode: dark status bar text and light navigation background', async () => {
  await act(async () => { await useThemeMode.getState().setMode('light') })
  render(<RootLayout />)
  await act(async () => {}) // flush hydrate — persisted mode stays light
  expect(lastProps<StatusBarProps>(StatusBar).style).toBe('dark')
  expect(lastProps<StackProps>(Stack).screenOptions.contentStyle.backgroundColor)
    .toBe(makeTheme('light').bg)
})
