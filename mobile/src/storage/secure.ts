import * as SecureStore from 'expo-secure-store'
import AsyncStorage from '@react-native-async-storage/async-storage'

const TOKEN_KEY = 'shepherd_token'
const BASE_URL_KEY = 'shepherd_base_url'

export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token)
}
export async function loadToken(): Promise<string | null> {
  return SecureStore.getItemAsync(TOKEN_KEY)
}
export async function clearToken(): Promise<void> {
  await SecureStore.deleteItemAsync(TOKEN_KEY)
}
export async function saveBaseURL(url: string): Promise<void> {
  await AsyncStorage.setItem(BASE_URL_KEY, url)
}
export async function loadBaseURL(): Promise<string | null> {
  return AsyncStorage.getItem(BASE_URL_KEY)
}

const LOCK_ENABLED_KEY = 'shepherd_lock_enabled'

export async function saveLockEnabled(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(LOCK_ENABLED_KEY, enabled ? 'true' : 'false')
}
export async function loadLockEnabled(): Promise<boolean> {
  return (await AsyncStorage.getItem(LOCK_ENABLED_KEY)) === 'true'
}

const THEME_KEY = 'shepherd_theme'

export async function saveThemeMode(mode: 'light' | 'dark'): Promise<void> {
  await AsyncStorage.setItem(THEME_KEY, mode)
}
export async function loadThemeMode(): Promise<'light' | 'dark' | null> {
  const v = await AsyncStorage.getItem(THEME_KEY)
  return v === 'light' || v === 'dark' ? v : null
}
