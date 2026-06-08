import * as LocalAuthentication from 'expo-local-authentication'

export async function hasHardware(): Promise<boolean> {
  return LocalAuthentication.hasHardwareAsync()
}
export async function isEnrolled(): Promise<boolean> {
  return LocalAuthentication.isEnrolledAsync()
}
export async function authenticate(): Promise<boolean> {
  const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock Shepherd' })
  return r.success
}
