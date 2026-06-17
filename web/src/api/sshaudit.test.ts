import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  listSSHAuditHosts,
  putSSHAuditHost,
  fetchSSHAuditSessions,
  fetchSSHAuditEvents,
  fetchSSHAuditSummary,
  collectSSHAuditHost,
} from './sshaudit'
import { api } from './client'

vi.mock('./client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
  },
}))

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>
const mockPost = api.post as unknown as ReturnType<typeof vi.fn>
const mockPut = api.put as unknown as ReturnType<typeof vi.fn>

describe('sshaudit api', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('listSSHAuditHosts GETs the hosts list', async () => {
    mockGet.mockResolvedValue([{ server_id: 1, enabled: true, poll_interval_seconds: 300, last_collect_at: null, last_error: null }])
    const out = await listSSHAuditHosts()
    expect(mockGet).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts')
    expect(out[0].server_id).toBe(1)
  })

  it('putSSHAuditHost PUTs enabled + interval', async () => {
    mockPut.mockResolvedValue({ ok: true })
    await putSSHAuditHost(7, { enabled: true, poll_interval_seconds: 900 })
    expect(mockPut).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/7', {
      enabled: true,
      poll_interval_seconds: 900,
    })
  })

  it('fetchSSHAuditSessions GETs the live sessions', async () => {
    mockGet.mockResolvedValue({ collected_at: '2026-06-16T00:00:00Z', sessions: [] })
    await fetchSSHAuditSessions(3)
    expect(mockGet).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/3/sessions')
  })

  it('fetchSSHAuditEvents encodes result + limit', async () => {
    mockGet.mockResolvedValue([])
    await fetchSSHAuditEvents(5, { result: 'failed', limit: 200 })
    expect(mockGet).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/5/events?result=failed&limit=200')
  })

  it('fetchSSHAuditEvents omits the query string when no params', async () => {
    mockGet.mockResolvedValue([])
    await fetchSSHAuditEvents(5)
    expect(mockGet).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/5/events')
  })

  it('fetchSSHAuditSummary GETs the summary', async () => {
    mockGet.mockResolvedValue({
      window_hours: 24, accepted: 0, failed: 0, unique_source_ips: 0,
      top_sources: [], top_failed_users: [],
    })
    await fetchSSHAuditSummary(9)
    expect(mockGet).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/9/summary')
  })

  it('collectSSHAuditHost POSTs to /collect', async () => {
    mockPost.mockResolvedValue({ ok: true, inserted: 4 })
    const out = await collectSSHAuditHost(2)
    expect(mockPost).toHaveBeenCalledWith('/api/admin/plugins/sshaudit/hosts/2/collect', {})
    expect(out.inserted).toBe(4)
  })
})
