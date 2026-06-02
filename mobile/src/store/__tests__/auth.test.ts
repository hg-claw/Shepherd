import { useAuth } from '../auth'

jest.mock('../../api/auth', () => ({
  loginRequest: jest.fn(),
  logoutRequest: jest.fn(async () => {}),
}))
jest.mock('../../storage/secure', () => {
  let token: string | null = null
  let base: string | null = null
  return {
    saveToken: jest.fn(async (t: string) => { token = t }),
    loadToken: jest.fn(async () => token),
    clearToken: jest.fn(async () => { token = null }),
    saveBaseURL: jest.fn(async (u: string) => { base = u }),
    loadBaseURL: jest.fn(async () => base),
  }
})
import { loginRequest } from '../../api/auth'
import { clearToken, loadToken } from '../../storage/secure'

beforeEach(() => {
  useAuth.setState({ status: 'loading', baseURL: null, token: null, admin: null, error: null })
  ;(loginRequest as jest.Mock).mockReset()
})

test('login success → signedIn + token persisted', async () => {
  ;(loginRequest as jest.Mock).mockResolvedValue({ id: 1, username: 'a', token: 'T' })
  await useAuth.getState().login('https://h', 'a', 'p')
  const s = useAuth.getState()
  expect(s.status).toBe('signedIn')
  expect(s.token).toBe('T')
  expect(await loadToken()).toBe('T')
})

test('login failure → error, stays signedOut', async () => {
  ;(loginRequest as jest.Mock).mockRejectedValue(Object.assign(new Error('bad creds'), { status: 401 }))
  await useAuth.getState().login('https://h', 'a', 'p')
  const s = useAuth.getState()
  expect(s.status).toBe('signedOut')
  expect(s.error).toBe('bad creds')
})

test('restore with stored token → signedIn', async () => {
  ;(loginRequest as jest.Mock).mockResolvedValue({ id: 1, username: 'a', token: 'T' })
  await useAuth.getState().login('https://h', 'a', 'p')
  useAuth.setState({ status: 'loading', token: null, admin: null })
  await useAuth.getState().restore()
  expect(useAuth.getState().status).toBe('signedIn')
})

test('logout wipes token + signs out', async () => {
  ;(loginRequest as jest.Mock).mockResolvedValue({ id: 1, username: 'a', token: 'T' })
  await useAuth.getState().login('https://h', 'a', 'p')
  await useAuth.getState().logout()
  expect(useAuth.getState().status).toBe('signedOut')
  expect(await loadToken()).toBeNull()
  expect(clearToken).toHaveBeenCalled()
})
