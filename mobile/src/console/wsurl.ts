export function consoleWSURL(baseURL: string, sid: string): string {
  const ws = baseURL.replace(/^http/, 'ws')
  return `${ws}/api/admin/console/ws?sid=${encodeURIComponent(sid)}`
}
