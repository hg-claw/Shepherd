import { ConsoleSession } from '../session'

class FakeWS {
  static last: FakeWS
  url: string; opts: any; binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  sent: unknown[] = []
  readyState = 0
  constructor(url: string, _p: unknown, opts: unknown) { this.url = url; this.opts = opts; FakeWS.last = this }
  send(d: unknown) { this.sent.push(d) }
  close() { this.readyState = 3; this.onclose?.() }
}
;(global as any).WebSocket = FakeWS

test('opens with bearer header, sends resize on open, routes frames', () => {
  const data: Uint8Array[] = []
  const control: any[] = []
  const status: string[] = []
  const s = new ConsoleSession('https://h', 'TKN', 'sid1', 24, 80, {
    onData: (b) => data.push(b), onControl: (m) => control.push(m), onStatus: (st) => status.push(st),
  })
  const ws = FakeWS.last
  expect(ws.url).toBe('wss://h/api/admin/console/ws?sid=sid1')
  expect(ws.opts.headers.Authorization).toBe('Bearer TKN')
  expect(ws.binaryType).toBe('arraybuffer')

  ws.readyState = 1
  ws.onopen!()
  expect(status).toContain('open')
  expect(JSON.parse(ws.sent[0] as string)).toEqual({ op: 'resize', rows: 24, cols: 80 })

  ws.onmessage!({ data: new Uint8Array([65, 66]).buffer })
  expect(Array.from(data[0])).toEqual([65, 66])
  ws.onmessage!({ data: JSON.stringify({ op: 'error', detail: 'x' }) })
  expect(control[0]).toEqual({ op: 'error', detail: 'x' })

  s.write(new Uint8Array([9]))
  expect(ws.sent[ws.sent.length - 1]).toBeInstanceOf(Uint8Array)
  s.resize(30, 100)
  expect(JSON.parse(ws.sent[ws.sent.length - 1] as string)).toEqual({ op: 'resize', rows: 30, cols: 100 })

  s.close()
  expect(status).toContain('closed')
})
