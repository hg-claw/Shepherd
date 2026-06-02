import { loginRequest, logoutRequest } from '../auth'

test('loginRequest posts client=mobile and returns token', async () => {
  const fetchMock = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 1, username: 'a', token: 'T' }) } as Response))
  global.fetch = fetchMock as unknown as typeof fetch
  const r = await loginRequest('https://h', 'a', 'p')
  expect(r.token).toBe('T')
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://h/api/login')
  expect(JSON.parse(init.body as string)).toEqual({ username: 'a', password: 'p', client: 'mobile' })
})

test('loginRequest throws when server returns no token (not R1+)', async () => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: 1, username: 'a' }) } as Response)) as unknown as typeof fetch
  await expect(loginRequest('https://h', 'a', 'p')).rejects.toThrow()
})

test('logoutRequest posts with bearer', async () => {
  const fetchMock = jest.fn(() => Promise.resolve({ ok: true, status: 204, json: () => Promise.reject(new Error('no body')) } as unknown as Response))
  global.fetch = fetchMock as unknown as typeof fetch
  await logoutRequest('https://h', 'T')
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://h/api/logout')
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer T')
})
