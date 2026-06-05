export function joinPath(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, '')}/${name}`.replace(/\/{2,}/g, '/')
}
export function parentPath(path: string): string {
  if (path === '/' || path === '') return '/'
  const i = path.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : path.slice(0, i)
}
export function crumbs(path: string): { label: string; path: string }[] {
  const out = [{ label: '/', path: '/' }]
  let acc = ''
  for (const seg of path.split('/').filter(Boolean)) {
    acc += '/' + seg
    out.push({ label: seg, path: acc })
  }
  return out
}
