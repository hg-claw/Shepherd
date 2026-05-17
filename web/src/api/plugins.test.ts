import { describe, it, expect, vi } from 'vitest'
import { listPlugins, enablePlugin } from './plugins'

vi.mock('./client', () => ({
  api: {
    get: vi.fn().mockResolvedValue([{ id: 'xray', enabled: false }]),
    post: vi.fn().mockResolvedValue({ enabled: true }),
    put: vi.fn(),
    del: vi.fn(),
  },
}))

describe('plugins api', () => {
  it('listPlugins returns array', async () => {
    const out = await listPlugins()
    expect(out[0].id).toBe('xray')
  })
  it('enablePlugin sends POST', async () => {
    const out = await enablePlugin('xray')
    expect(out.enabled).toBe(true)
  })
})
