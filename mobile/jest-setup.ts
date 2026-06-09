jest.mock('expo-secure-store', () => {
  const mem: Record<string, string> = {}
  return {
    setItemAsync: jest.fn(async (k: string, v: string) => { mem[k] = v }),
    getItemAsync: jest.fn(async (k: string) => (k in mem ? mem[k] : null)),
    deleteItemAsync: jest.fn(async (k: string) => { delete mem[k] }),
  }
})
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'))
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: false })),
}))
jest.mock('react-native-safe-area-context', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('react-native-safe-area-context/jest/mock')
  return m.default ?? m
})
jest.mock('expo-font', () => ({ useFonts: () => [true, null], isLoaded: () => true, loadAsync: jest.fn() }))
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true), getStringAsync: jest.fn(async () => '') }))
