import { openConsole } from '../console'
jest.mock('../authed', () => ({ authedFetch: jest.fn() }))
import { authedFetch } from '../authed'

test('openConsole posts the right body + returns sid', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ session_id: 5, sid: 'abc' })
  const r = await openConsole(7, 24, 80)
  expect(r.sid).toBe('abc')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/console/open', {
    method: 'POST',
    body: { server_id: 7, user: '', rows: 24, cols: 80, term: 'xterm-256color' },
  })
})
