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
