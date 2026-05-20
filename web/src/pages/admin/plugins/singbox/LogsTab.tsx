import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { listPluginHosts, pluginLogsWSURL } from '@/api/plugins'

interface LogLine { ts: string; level: string; line: string }

export default function LogsTab() {
  const hostsQ = useQuery({ queryKey: ['plugin-hosts', 'singbox'], queryFn: () => listPluginHosts('singbox') })
  const [serverID, setServerID] = useState<number | null>(null)
  useEffect(() => {
    if (serverID == null && hostsQ.data?.length) setServerID(hostsQ.data[0].server_id)
  }, [hostsQ.data, serverID])

  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (serverID == null) return
    setLines([])
    const ws = new WebSocket(pluginLogsWSURL('singbox', serverID))
    wsRef.current = ws
    ws.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data) as LogLine
        setLines((prev) => paused ? prev : [...prev.slice(-1999), env])
      } catch {}
    }
    return () => { ws.close() }
  }, [serverID, paused])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={serverID ?? ''}
          onChange={(e) => setServerID(Number(e.target.value))}
          className="h-8 px-2 rounded-md border bg-background text-[13px] font-mono"
        >
          {(hostsQ.data ?? []).map((h) => (
            <option key={h.id} value={h.server_id}>#{h.server_id}</option>
          ))}
        </select>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setPaused((v) => !v)}>
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => setLines([])}>
          Clear
        </Button>
      </div>
      <div className="h-[440px] bg-[#0a0a0b] text-zinc-100 rounded-lg overflow-auto p-3 font-mono text-[12px] leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap">
            <span className="text-zinc-500 mr-2">{l.ts.slice(11, 19)}</span>
            <span>{l.line}</span>
          </div>
        ))}
        {lines.length === 0 && <div className="text-zinc-500">waiting for log lines…</div>}
      </div>
    </div>
  )
}
