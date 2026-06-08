import { deployHost, undeployHost, startHost, stopHost, restartHost, refreshHost } from '../plugins'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

beforeEach(() => (authedFetch as jest.Mock).mockResolvedValue({}))

test('host actions hit the right method + path', async () => {
  await deployHost('xray', { server_id: 7, version: 'v1' })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts', { method: 'POST', body: { server_id: 7, version: 'v1' } })
  await undeployHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7', { method: 'DELETE' })
  await startHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/start', { method: 'POST' })
  await stopHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/stop', { method: 'POST' })
  await restartHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/restart', { method: 'POST' })
  await refreshHost('xray', 7)
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/plugins/xray/hosts/7/refresh-status')
})
