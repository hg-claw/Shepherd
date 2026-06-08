// wsURL turns an https/http baseURL + a path into a wss/ws URL. Tolerates a
// trailing slash and an uppercase scheme (else a 'wss://h//api' or untransformed
// 'HTTPS://' would 404 the handshake).
export function wsURL(baseURL: string, path: string): string {
  const base = baseURL.trim().replace(/\/+$/, '')
  const ws = base.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')
  return `${ws}${path}`
}
