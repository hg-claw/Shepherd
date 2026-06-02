import { apiFetch, APIError } from '../client'

const okJson = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response)

afterEach(() => { (global.fetch as jest.Mock | undefined)?.mockReset?.() })

test('attaches bearer + parses json', async () => {
  global.fetch = jest.fn(() => okJson({ n: 1 })) as unknown as typeof fetch
  const out = await apiFetch<{ n: number }>('https://h', 'tok', '/api/x')
  expect(out.n).toBe(1)
  const [url, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect(url).toBe('https://h/api/x')
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
})

test('omits bearer when token null', async () => {
  global.fetch = jest.fn(() => okJson({})) as unknown as typeof fetch
  await apiFetch('https://h', null, '/api/x')
  const [, init] = (global.fetch as jest.Mock).mock.calls[0]
  expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
})

test('throws APIError with server message on non-2xx', async () => {
  global.fetch = jest.fn(() => okJson({ error: 'nope' }, 400)) as unknown as typeof fetch
  await expect(apiFetch('https://h', 't', '/x')).rejects.toMatchObject({ status: 400, message: 'nope' })
})

test('401 surfaces as APIError(401)', async () => {
  global.fetch = jest.fn(() => okJson({ error: 'unauthorized' }, 401)) as unknown as typeof fetch
  await expect(apiFetch('https://h', 't', '/x')).rejects.toBeInstanceOf(APIError)
})
