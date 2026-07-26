import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { listPluginEvents } from '@/api/plugins'
import { Pill, type PillKind } from '@/components/Pill'
import { useVirtualRows } from '@/lib/useVirtualRows'

function resultKind(r: string): PillKind {
  return r === 'ok' ? 'ok' : 'err'
}

const COLS = 4

export default function EventsTab() {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['plugin-events', 'singbox'],
    queryFn: () => listPluginEvents('singbox', { limit: 200 }),
    refetchInterval: 10_000,
  })
  const rows = q.data ?? []
  const { parentRef, items, padTop, padBottom } = useVirtualRows(rows)
  return (
    <div className="rounded-lg border bg-elev">
      <div ref={parentRef} className="max-h-[70vh] overflow-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left">
              <th className="px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground">{t('singbox.events.time', 'Time')}</th>
              <th className="px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground">{t('singbox.events.action', 'Action')}</th>
              <th className="px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground">{t('singbox.events.host', 'Host')}</th>
              <th className="px-3 py-2 text-left align-middle font-medium text-2xs uppercase tracking-[0.05em] text-muted-foreground">{t('singbox.events.result', 'Result')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={COLS} className="px-3 py-6 text-center text-sm text-muted-foreground">{t('singbox.empty.events', 'No events yet.')}</td></tr>
            ) : (
              <>
                {padTop > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padTop }} /></tr>}
                {items.map((vi) => {
                  const e = rows[vi.index]
                  return (
                    <tr key={vi.index} data-index={vi.index} className="border-t transition-colors hover:bg-sunken/60">
                      <td className="px-3 py-2 align-middle font-mono text-xs text-fg-dim whitespace-nowrap">{e.ts}</td>
                      <td className="px-3 py-2 align-middle font-mono text-sm">{e.action}</td>
                      <td className="px-3 py-2 align-middle font-mono text-xs">{e.server_id ?? '—'}</td>
                      <td className="px-3 py-2 align-middle"><Pill kind={resultKind(e.result)}>{e.result}</Pill></td>
                    </tr>
                  )
                })}
                {padBottom > 0 && <tr aria-hidden><td colSpan={COLS} style={{ height: padBottom }} /></tr>}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
