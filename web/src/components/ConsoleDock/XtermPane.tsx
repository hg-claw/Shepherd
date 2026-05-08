import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { consoleWSURL } from '@/api/console'
import { useConsoleTabs } from '@/store/consoleTabs'

interface Props {
  tabId: string
  sid: string
}

export function XtermPane({ tabId, sid }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const setStatus = useConsoleTabs((s) => s.setStatus)
  useEffect(() => {
    if (!ref.current) return
    const term = new Terminal({ convertEol: false, fontFamily: 'Menlo, monospace', fontSize: 13 })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(ref.current)
    fit.fit()

    const ws = new WebSocket(consoleWSURL(sid))
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      setStatus(tabId, 'open')
      ws.send(JSON.stringify({ op: 'resize', rows: term.rows, cols: term.cols }))
    }
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data)
          if (m.op === 'exited') setStatus(tabId, 'exited', m.code)
        } catch {
          // ignore parse errors
        }
        return
      }
      term.write(new Uint8Array(ev.data as ArrayBuffer))
    }
    term.onData((d) => {
      if (ws.readyState === 1) ws.send(new TextEncoder().encode(d))
    })

    const ro = new ResizeObserver(() => {
      fit.fit()
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ op: 'resize', rows: term.rows, cols: term.cols }))
      }
    })
    ro.observe(ref.current)

    return () => {
      ws.close()
      term.dispose()
      ro.disconnect()
    }
  }, [tabId, sid, setStatus])

  return <div ref={ref} className="h-full w-full" />
}
