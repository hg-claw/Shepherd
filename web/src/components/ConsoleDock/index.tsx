import { useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { useConsoleTabs } from '@/store/consoleTabs'
import { cn } from '@/lib/utils'
import { XtermPane } from './XtermPane'

export function ConsoleDock() {
  const { tabs, active, focus, close } = useConsoleTabs()
  const [collapsed, setCollapsed] = useState(false)
  if (tabs.length === 0) return null

  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-50 flex flex-col',
        'border-t border-zinc-800',
        'bg-[#09090b] text-zinc-100',
        'font-mono',
        'transition-[height] duration-150',
        'pb-[env(safe-area-inset-bottom)]',
        collapsed ? 'h-9' : 'h-64 sm:h-80',
      )}
    >
      {/* Tab bar */}
      <div
        className={cn(
          'flex items-center gap-1 px-2 py-1 overflow-x-auto shrink-0',
          'bg-zinc-900',
          !collapsed && 'border-b border-zinc-800',
        )}
      >
        {/* Tabs */}
        <div className="flex gap-1 flex-1 min-w-0 overflow-x-auto">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                focus(t.id)
                setCollapsed(false)
              }}
              className={cn(
                'group flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-sm shrink-0 max-w-[12rem]',
                'transition-colors',
                t.id === active
                  ? 'bg-zinc-700 text-zinc-50'
                  : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-700/70 hover:text-zinc-200',
                t.status === 'exited' && 'opacity-60',
              )}
            >
              {/* Status dot */}
              <span
                className={cn(
                  'inline-block h-1.5 w-1.5 rounded-full shrink-0',
                  t.status === 'open' ? 'bg-emerald-400' : 'bg-zinc-500',
                )}
              />
              <span className="truncate">
                {t.title}
                {t.status === 'exited' ? ` (exit ${t.exitCode})` : ''}
              </span>
              <span
                role="button"
                aria-label="close tab"
                className={cn(
                  'ml-0.5 inline-flex h-3.5 w-3.5 items-center justify-center rounded',
                  'opacity-0 group-hover:opacity-100 hover:bg-zinc-600',
                  'transition-opacity',
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  close(t.id)
                }}
              >
                <X className="h-2.5 w-2.5" />
              </span>
            </button>
          ))}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 ml-auto shrink-0">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
            aria-label={collapsed ? 'expand console' : 'collapse console'}
          >
            {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal panes */}
      {!collapsed && (
        <div className="flex-1 relative overflow-hidden">
          {tabs.map((t) => (
            <div key={t.id} className={cn('absolute inset-0', t.id === active ? '' : 'hidden')}>
              <XtermPane tabId={t.id} sid={t.sid} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
