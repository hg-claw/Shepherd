import { authedText } from '../authed'
import { APIError } from '../client'
import { useAuth } from '../../store/auth'

beforeEach(() => { useAuth.setState({ status: 'signedIn', baseURL: 'https://h', token: 'T', admin: null, error: null }) })

test('200 returns text', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('hello') } as Response)) as unknown as typeof fetch
  await expect(authedText('/p')).resolves.toBe('hello')
  const [, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer T')
})
test('401 clears session and throws', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 401, text: () => Promise.resolve('') } as Response)) as unknown as typeof fetch
  await expect(authedText('/p')).rejects.toBeInstanceOf(APIError)
  expect(useAuth.getState().status).toBe('signedOut')
})
test('non-401 throws without clearing', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 415, text: () => Promise.resolve('binary') } as Response)) as unknown as typeof fetch
  await expect(authedText('/p')).rejects.toMatchObject({ status: 415 })
  expect(useAuth.getState().status).toBe('signedIn')
})
test('missing baseURL throws without fetch', async () => {
  useAuth.setState({ baseURL: null })
  global.fetch = jest.fn() as unknown as typeof fetch
  await expect(authedText('/p')).rejects.toBeInstanceOf(APIError)
  expect(global.fetch).not.toHaveBeenCalled()
})
