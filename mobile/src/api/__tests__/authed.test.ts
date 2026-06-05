import { authedFetch } from '../authed'
import { APIError } from '../client'
import { useAuth } from '../../store/auth'

jest.mock('../client', () => ({
  APIError: jest.requireActual('../client').APIError,
  apiFetch: jest.fn(),
}))
import { apiFetch } from '../client'

beforeEach(() => {
  useAuth.setState({ status: 'signedIn', baseURL: 'https://h', token: 'T', admin: null, error: null })
  ;(apiFetch as jest.Mock).mockReset()
})

test('200 returns body, no session change', async () => {
  ;(apiFetch as jest.Mock).mockResolvedValue({ ok: 1 })
  await expect(authedFetch('/api/x')).resolves.toEqual({ ok: 1 })
  expect(useAuth.getState().status).toBe('signedIn')
})

test('401 clears session and re-throws', async () => {
  ;(apiFetch as jest.Mock).mockRejectedValue(new APIError(401, 'unauthorized'))
  await expect(authedFetch('/api/x')).rejects.toBeInstanceOf(APIError)
  expect(useAuth.getState().status).toBe('signedOut')
})

test('non-401 error re-throws WITHOUT clearing session', async () => {
  ;(apiFetch as jest.Mock).mockRejectedValue(new APIError(500, 'boom'))
  await expect(authedFetch('/api/x')).rejects.toMatchObject({ status: 500 })
  expect(useAuth.getState().status).toBe('signedIn')
})

test('missing baseURL throws without calling apiFetch', async () => {
  useAuth.setState({ baseURL: null })
  await expect(authedFetch('/api/x')).rejects.toBeInstanceOf(APIError)
  expect(apiFetch).not.toHaveBeenCalled()
})
