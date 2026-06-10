import { focusManager } from '@tanstack/react-query'
import { onAppStateChange } from '../_layout'

// _layout renders <Stack/> inline — keep the route mock shape expo-router-safe.
jest.mock('expo-router', () => ({ Stack: Object.assign(() => null, { Screen: () => null }) }))

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
