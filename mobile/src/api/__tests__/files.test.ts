import { listDir, previewFile } from '../files'
jest.mock('../authed', () => ({ authedFetch: jest.fn(), authedText: jest.fn() }))
import { authedFetch, authedText } from '../authed'

test('listDir hits the right url', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue([{ name: 'x', is_dir: true, size: 0, mode: 0, mtime: 0 }])
  const out = await listDir(7, '/etc')
  expect(out[0].name).toBe('x')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/files?server_id=7&path=%2Fetc')
})
test('previewFile returns text', async () => {
  ;(authedText as jest.Mock).mockResolvedValue('contents')
  await expect(previewFile(7, '/a.txt')).resolves.toEqual({ kind: 'text', text: 'contents' })
})
test('previewFile maps 415 to binary', async () => {
  const { APIError } = jest.requireActual('../client')
  ;(authedText as jest.Mock).mockRejectedValue(new APIError(415, 'binary content'))
  await expect(previewFile(7, '/a.bin')).resolves.toEqual({ kind: 'binary' })
})
