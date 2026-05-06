import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, APIError, setOn401 } from './client'

const origFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn()
})
afterEach(() => {
  globalThis.fetch = origFetch
})

function mockResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

describe('api.get', () => {
  it('parses JSON', async () => {
    ;(globalThis.fetch as any).mockReturnValueOnce(mockResponse({ ok: true }))
    const out = await api.get<{ ok: boolean }>('/api/x')
    expect(out).toEqual({ ok: true })
  })

  it('throws APIError with body.error message', async () => {
    ;(globalThis.fetch as any).mockReturnValueOnce(mockResponse({ error: 'bad creds' }, 401))
    let caught: APIError | undefined
    let triggered = false
    setOn401(() => (triggered = true))
    try {
      await api.get('/api/login')
    } catch (e) {
      caught = e as APIError
    }
    expect(caught?.status).toBe(401)
    expect(triggered).toBe(true)
  })
})

describe('api.post', () => {
  it('204 returns undefined', async () => {
    ;(globalThis.fetch as any).mockReturnValueOnce(Promise.resolve(new Response(null, { status: 204 })))
    const out = await api.post<void>('/api/x')
    expect(out).toBeUndefined()
  })
})
