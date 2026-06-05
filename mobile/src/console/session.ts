import { consoleWSURL } from './wsurl'

export type ConsoleStatus = 'connecting' | 'open' | 'closed' | 'error'
export type ConsoleHandlers = {
  onData?: (bytes: Uint8Array) => void
  onControl?: (msg: { op: string; detail?: string }) => void
  onStatus?: (s: ConsoleStatus) => void
}

export class ConsoleSession {
  private ws: WebSocket
  private rows: number
  private cols: number

  constructor(baseURL: string, token: string | null, sid: string, rows: number, cols: number, private h: ConsoleHandlers) {
    this.rows = rows
    this.cols = cols
    const url = consoleWSURL(baseURL, sid)
    const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
    this.ws = new (global as unknown as { WebSocket: new (url: string, protocols: unknown, options: unknown) => WebSocket }).WebSocket(url, undefined, opts)
    this.ws.binaryType = 'arraybuffer'
    this.h.onStatus?.('connecting')
    this.ws.onopen = () => {
      this.h.onStatus?.('open')
      this.resize(this.rows, this.cols)
    }
    this.ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') {
        try { this.h.onControl?.(JSON.parse(e.data) as { op: string; detail?: string }) } catch { /* ignore */ }
      } else {
        this.h.onData?.(new Uint8Array(e.data as ArrayBuffer))
      }
    }
    this.ws.onerror = () => this.h.onStatus?.('error')
    this.ws.onclose = () => this.h.onStatus?.('closed')
  }

  write(bytes: Uint8Array): void {
    if (this.ws.readyState === 1) this.ws.send(bytes)
  }
  resize(rows: number, cols: number): void {
    this.rows = rows
    this.cols = cols
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: 'resize', rows, cols }))
  }
  close(): void {
    this.ws.close()
  }
}
