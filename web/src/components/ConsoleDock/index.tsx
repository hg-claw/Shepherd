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
        'fixed bottom-0 left-0 right-0 border-t bg-zinc-950 text-zinc-100 flex flex-col z-50',
        'pb-[env(safe-area-inset-bottom)]',
        collapsed ? 'h-9' : 'h-64 sm:h-80',
      )}
    >
      <div className="flex items-center gap-1 bg-zinc-900 px-2 py-1 overflow-x-auto">
        <div className="flex gap-1 flex-1 min-w-0">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                focus(t.id)
                setCollapsed(false)
              }}
              className={cn(
                'group flex items-center gap-1 px-2 py-0.5 text-xs rounded-sm shrink-0 max-w-[12rem]',
                t.id === active ? 'bg-zinc-700' : 'bg-zinc-800 hover:bg-zinc-700/70',
                t.status === 'exited' && 'opacity-60',
              )}
            >
              <span className="truncate">
                {t.title}
                {t.status === 'exited' ? ` (exit ${t.exitCode})` : ''}
              </span>
              <span
                role="button"
                aria-label="close tab"
                className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-zinc-600"
                onClick={(e) => {
                  e.stopPropagation()
                  close(t.id)
                }}
              >
                <X className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded hover:bg-zinc-700 shrink-0"
          aria-label={collapsed ? 'expand console' : 'collapse console'}
        >
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
      </div>
      {!collapsed && (
        <div className="flex-1 relative">
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
