export function b64encode(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return globalThis.btoa(bin)
}
export function b64decode(b64: string): Uint8Array {
  const bin = globalThis.atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function dataMsg(bytes: Uint8Array): string {
  return JSON.stringify({ type: 'data', b64: b64encode(bytes) })
}
export function fitMsg(): string {
  return JSON.stringify({ type: 'fit' })
}

export type FromWebView =
  | { type: 'input'; bytes: Uint8Array }
  | { type: 'resize'; rows: number; cols: number }
  | { type: 'ready' }

export function parseFromWebView(raw: string): FromWebView | null {
  let m: unknown
  try { m = JSON.parse(raw) } catch { return null }
  if (typeof m !== 'object' || m === null) return null
  const o = m as Record<string, unknown>
  if (o.type === 'input' && typeof o.b64 === 'string') return { type: 'input', bytes: b64decode(o.b64) }
  if (o.type === 'resize' && typeof o.rows === 'number' && typeof o.cols === 'number') return { type: 'resize', rows: o.rows, cols: o.cols }
  if (o.type === 'ready') return { type: 'ready' }
  return null
}
