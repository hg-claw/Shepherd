import { joinPath, parentPath, crumbs } from '../paths'
test('joinPath', () => {
  expect(joinPath('/a/b', 'c')).toBe('/a/b/c')
  expect(joinPath('/', 'c')).toBe('/c')
  expect(joinPath('/a/', 'b')).toBe('/a/b')
})
test('parentPath', () => {
  expect(parentPath('/a/b')).toBe('/a')
  expect(parentPath('/a')).toBe('/')
  expect(parentPath('/')).toBe('/')
})
test('crumbs', () => {
  expect(crumbs('/a/b')).toEqual([{ label: '/', path: '/' }, { label: 'a', path: '/a' }, { label: 'b', path: '/a/b' }])
})
