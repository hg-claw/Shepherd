import { listDir, previewFile, mkdir, renamePath, rmPath } from '../files'
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

// Wire shapes below mirror internal/api/files_routes.go filePathReq.
test('mkdir posts server_id + path', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await expect(mkdir(7, '/etc/new dir')).resolves.toEqual({ ok: true })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/files/mkdir', {
    method: 'POST',
    body: { server_id: 7, path: '/etc/new dir' },
  })
})
test('renamePath posts server_id + src/dst', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await expect(renamePath(7, '/etc/a.conf', '/etc/b.conf')).resolves.toEqual({ ok: true })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/files/rename', {
    method: 'POST',
    body: { server_id: 7, src: '/etc/a.conf', dst: '/etc/b.conf' },
  })
})
test('rmPath posts server_id + path + recursive', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await expect(rmPath(7, '/var/tmp/dir', true)).resolves.toEqual({ ok: true })
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/files/rm', {
    method: 'POST',
    body: { server_id: 7, path: '/var/tmp/dir', recursive: true },
  })
})
test('rmPath defaults recursive to false', async () => {
  ;(authedFetch as jest.Mock).mockResolvedValue({ ok: true })
  await rmPath(7, '/var/tmp/file.txt')
  expect(authedFetch).toHaveBeenCalledWith('/api/admin/files/rm', {
    method: 'POST',
    body: { server_id: 7, path: '/var/tmp/file.txt', recursive: false },
  })
})
