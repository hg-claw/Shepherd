import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { listPluginHosts, pluginLogsWSURL } from '@/api/plugins'

interface LogLine { ts: string; level: string; line: string }

// PluginLogsTab streams a plugin's live logs for a selected host. Pause is a
// display gate (a ref read inside onmessage), NOT an effect dependency — so
// pausing neither reconnects the socket nor clears the buffer.
export function PluginLogsTab({ plugin }: { plugin: 'xray' | 'singbox' }) {
  const { t } = useTranslation()
  const hostsQ = useQuery({ queryKey: ['plugin-hosts', plugin], queryFn: () => listPluginHosts(plugin) })
  const [serverID, setServerID] = useState<number | null>(null)
  useEffect(() => {
    if (serverID == null && hostsQ.data?.length) setServerID(hostsQ.data[0].server_id)
  }, [hostsQ.data, serverID])

  const [lines, setLines] = useState<LogLine[]>([])
  const [paused, setPaused] = useState(false)
  const pausedRef = useRef(false)
  useEffect(() => { pausedRef.current = paused }, [paused])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (serverID == null) return
    setLines([])
    const ws = new WebSocket(pluginLogsWSURL(plugin, serverID))
    wsRef.current = ws
    ws.onmessage = (e) => {
      try {
        const env = JSON.parse(e.data) as LogLine
        if (!pausedRef.current) setLines((prev) => [...prev.slice(-1999), env])
      } catch {
        /* ignore */
      }
    }
    return () => { ws.close() }
  }, [serverID, plugin])

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Select
          value={serverID != null ? String(serverID) : undefined}
          onValueChange={(v) => setServerID(Number(v))}
        >
          <SelectTrigger className="h-8 w-32 font-mono text-sm" aria-label={t('plugins.logs.select_server_aria', 'select server')}>
            <SelectValue placeholder={t('plugins.logs.select_server_placeholder', 'select server')} />
          </SelectTrigger>
          <SelectContent>
            {(hostsQ.data ?? []).map((h) => (
              <SelectItem key={h.id} value={String(h.server_id)}>#{h.server_id}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => setPaused((v) => !v)}>
          {paused ? t('plugins.logs.resume', 'Resume') : t('plugins.logs.pause', 'Pause')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setLines([])}>
          {t('plugins.logs.clear', 'Clear')}
        </Button>
      </div>
      <div className="h-[440px] bg-console text-console-fg rounded-lg overflow-auto p-3 font-mono text-xs leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="whitespace-pre-wrap">
            <span className="text-console-muted mr-2">{l.ts.slice(11, 19)}</span>
            <span>{l.line}</span>
          </div>
        ))}
        {lines.length === 0 && <div className="text-console-muted">{t('plugins.logs.waiting', 'waiting for log lines…')}</div>}
      </div>
    </div>
  )
}
